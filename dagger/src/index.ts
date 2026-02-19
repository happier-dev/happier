/**
 * A generated module for HappierPipeline functions
 *
 * This module has been generated via dagger init and serves as a reference to
 * basic module structure as you get started with Dagger.
 *
 * Two functions have been pre-created. You can modify, delete, or add to them,
 * as needed. They demonstrate usage of arguments and return types using simple
 * echo and grep commands. The functions can be called from the dagger CLI or
 * from one of the SDKs.
 *
 * The first line in this comment block is a short description line and the
 * rest is a long description with more detail on the module's purpose or usage,
 * if appropriate. All modules should have a short description.
 */
import path from "node:path"
import { dag, Container, Directory, Secret, object, func } from "@dagger.io/dagger"

@object()
export class HappierPipeline {
  /**
   * Returns a container that echoes whatever string argument is provided
   */
  @func()
  containerEcho(stringArg: string): Container {
    return dag.container().from("alpine:latest").withExec(["echo", stringArg])
  }

  /**
   * Publishes a prebuilt npm tarball using the shared pipeline script.
   *
   * This is designed for non-interactive publishing:
   * - Pass `npmToken` from CI (env://NPM_TOKEN) or from local secret managers.
   * - Provide the tarball path relative to the mounted repo directory.
   */
  @func()
  async npmPublishTarball(
    repo: Directory,
    channel: string,
    tarballPath: string,
    npmToken: Secret,
    dryRun: boolean = false,
  ): Promise<string> {
    return dag
      .container()
      .from("node:22-bookworm-slim")
      .withMountedDirectory("/repo", repo)
      .withWorkdir("/repo")
      .withSecretVariable("NODE_AUTH_TOKEN", npmToken)
      .withExec([
        "node",
        "scripts/pipeline/npm/publish-tarball.mjs",
        "--channel",
        channel,
        "--tarball",
        tarballPath,
        ...(dryRun ? ["--dry-run"] : []),
      ])
      .stdout()
  }

  /**
   * Builds Happier UI Mobile Android artifacts using a Linux container (no local Android SDK required).
   *
   * This is intended for local macOS development where installing Java/Android SDK is undesirable.
   * It runs the shared pipeline script in a container and returns the build artifacts as a Directory.
   *
   * Export should be handled by the caller (e.g. `dagger call --output ...` or chaining `export`) so
   * it works consistently across local + CI runtimes.
   */
  @func()
  async expoAndroidLocalBuild(
    repo: Directory,
    profile: string,
    artifactName: string,
    outJsonName: string,
    expoToken: Secret,
    easCliVersion: string = "18.0.1",
    nodeVersion: string = "22.14.0",
  ): Promise<Directory> {
    const workdir = "/repo"
    const ext = path.extname(artifactName || "") || ".apk"
    const internalArtifact = `/tmp/happier-ui-mobile-android${ext}`
    const internalOutJson = "/tmp/eas_build_android.json"

    const container = dag
      .container({ platform: "linux/amd64" })
      .from("ghcr.io/cirruslabs/android-sdk:34")
      .withExec([
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          "apt-get update",
          "apt-get install -y --no-install-recommends ca-certificates curl xz-utils git",
          "rm -rf /var/lib/apt/lists/*",
        ].join(" && "),
      ])
      .withExec([
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          'arch="$(uname -m)"',
          'case "$arch" in x86_64) node_arch="x64" ;; aarch64|arm64) node_arch="arm64" ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac',
          `curl -fsSL "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-\${node_arch}.tar.xz" | tar -xJ -C /usr/local --strip-components=1`,
          "node --version",
          "corepack enable",
          "corepack prepare yarn@1.22.22 --activate",
          "yarn --version",
        ].join(" && "),
      ])
      .withMountedDirectory(workdir, repo)
      .withWorkdir(workdir)
      .withExec(["git", "init"])
      .withSecretVariable("EXPO_TOKEN", expoToken)
      .withEnvVariable("EAS_CLI_VERSION", easCliVersion)
      .withEnvVariable("HAPPIER_INSTALL_SCOPE", "ui,protocol,agents")
      .withEnvVariable("HAPPIER_UI_VENDOR_WEB_ASSETS", "0")
      .withEnvVariable("npm_config_registry", "https://registry.npmjs.org")
      .withEnvVariable("NPM_CONFIG_REGISTRY", "https://registry.npmjs.org")
      .withMountedCache("/root/.cache/yarn", dag.cacheVolume("happier-yarn-cache"))
      .withMountedCache("/root/.gradle", dag.cacheVolume("happier-gradle-cache"))
      .withExec(["yarn", "config", "set", "registry", "https://registry.npmjs.org/"])
      .withExec([
        "yarn",
        "install",
        "--frozen-lockfile",
        "--ignore-engines",
        "--network-timeout",
        "600000",
        "--prefer-offline",
        "--non-interactive",
      ])
      .withExec([
        "node",
        "scripts/pipeline/expo/native-build.mjs",
        "--platform",
        "android",
        "--profile",
        profile,
        "--out",
        internalOutJson,
        "--build-mode",
        "local",
        "--artifact-out",
        internalArtifact,
        "--eas-cli-version",
        easCliVersion,
      ])

    return dag
      .directory()
      .withFile(artifactName, container.file(internalArtifact))
      .withFile(outJsonName, container.file(internalOutJson))
  }
}
