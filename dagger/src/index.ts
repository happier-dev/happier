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
    sentryAuthToken: Secret,
    easCliVersion: string = "18.0.1",
    nodeOptions: string = "--max-old-space-size=3072",
    nodeVersion: string = "22.14.0",
    expoAppSlug: string = "",
    expoAppScheme: string = "",
    expoAppName: string = "",
    expoAppBundleId: string = "",
    containerPlatform: string = "linux/amd64",
  ): Promise<Directory> {
    const workdir = "/repo"
    const ext = path.extname(artifactName || "") || ".apk"
    // Note: /tmp is mounted as tmpfs to keep EAS local build working dirs off the container snapshot.
    // Dagger cannot reliably export files from tmpfs, so we write the *final* artifacts under /repo.
    const artifactDir = `${workdir}/.project/dagger-artifacts`
    const internalArtifact = `${artifactDir}/happier-ui-mobile-android${ext}`
    const internalOutJson = `${artifactDir}/eas_build_android.json`

    const easWorkdirRoot = "/tmp/eas-workdir"
    // EAS local build requires the working dir itself to be empty. Because we mount a persistent
    // cache volume at `easWorkdirRoot`, use a per-invocation subdir so residues from prior runs
    // cannot block subsequent builds even if Dagger caches intermediate exec steps.
    const easWorkdir = `${easWorkdirRoot}/run-${Date.now()}-${Math.random().toString(16).slice(2)}`

    let container = dag.container({ platform: containerPlatform })
      .from("ghcr.io/cirruslabs/android-sdk:34")
      // EAS local builds generate a large working directory. Mount it as a cache volume so:
      // - we avoid tmpfs ENOSPC failures
      // - we avoid exploding the container snapshot/engine cache
      .withMountedCache(easWorkdirRoot, dag.cacheVolume("happier-expo-eas-workdir"))
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
      .withExec(["bash", "-lc", `set -euo pipefail && mkdir -p "${artifactDir}"`])
      .withEnvVariable("HAPPIER_PIPELINE_LOCAL_RUNTIME", "dagger")
      .withSecretVariable("EXPO_TOKEN", expoToken)
      .withSecretVariable("SENTRY_AUTH_TOKEN", sentryAuthToken)
      .withEnvVariable("EAS_CLI_VERSION", easCliVersion)
      .withEnvVariable("NODE_OPTIONS", nodeOptions)
      .withEnvVariable("HAPPIER_INSTALL_SCOPE", "ui,protocol,agents")
      .withEnvVariable("HAPPIER_UI_VENDOR_WEB_ASSETS", "0")

    container = container
      .withEnvVariable("npm_config_registry", "https://registry.npmjs.org")
      .withEnvVariable("NPM_CONFIG_REGISTRY", "https://registry.npmjs.org")
      .withMountedCache("/root/.cache/yarn", dag.cacheVolume("happier-yarn-cache"))
      .withMountedCache("/root/.gradle", dag.cacheVolume("happier-gradle-cache"))
      .withExec(["yarn", "config", "set", "registry", "https://registry.npmjs.org/"])
      .withExec([
        "sh",
        "docker/scripts/yarn-install-with-retry.sh",
        "--frozen-lockfile",
        "--ignore-engines",
        "--network-timeout",
        "600000",
        "--prefer-offline",
        "--non-interactive",
      ])

    if (expoAppSlug) {
      container = container.withEnvVariable("EXPO_APP_SLUG", expoAppSlug)
    }
    if (expoAppScheme) {
      container = container.withEnvVariable("EXPO_APP_SCHEME", expoAppScheme)
    }
    if (expoAppName) {
      container = container.withEnvVariable("EXPO_APP_NAME", expoAppName)
    }
    if (expoAppBundleId) {
      container = container.withEnvVariable("EXPO_APP_BUNDLE_ID", expoAppBundleId)
    }

    container = container
      // EAS local build plugin requires an empty working directory. Create a fresh directory
      // inside the mounted cache volume for each run.
      .withExec(["bash", "-lc", `set -euo pipefail && rm -rf "${easWorkdir}" && mkdir -p "${easWorkdir}"`])
      .withEnvVariable("EAS_LOCAL_BUILD_WORKINGDIR", easWorkdir)
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
