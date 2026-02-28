// @ts-check

import path from "node:path";

/**
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function sentryCliBinName(platform) {
  return platform === "win32" ? "sentry-cli.cmd" : "sentry-cli";
}

/**
 * @param {{ repoRoot: string; platform?: NodeJS.Platform }} input
 * @returns {string}
 */
export function resolveSentryCliPath(input) {
  const bin = sentryCliBinName(input.platform ?? process.platform);
  return path.join(input.repoRoot, "node_modules", ".bin", bin);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function resolveSentryProjects(env) {
  const raw = String(env.SENTRY_PROJECTS ?? env.HAPPIER_SENTRY_PROJECTS ?? "").trim();
  if (!raw) return ["happier-server", "happier-ui"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{ env: NodeJS.ProcessEnv; release: string; requireCi?: boolean }} input
 * @returns {{ enabled: boolean; reason?: string }}
 */
export function shouldTrackSentryRelease(input) {
  const token = String(input.env.SENTRY_AUTH_TOKEN ?? "").trim();
  if (!token) return { enabled: false, reason: "missing SENTRY_AUTH_TOKEN" };

  const org = String(input.env.SENTRY_ORG ?? input.env.HAPPIER_SENTRY_ORG ?? "happier-devs").trim();
  if (!org) return { enabled: false, reason: "missing SENTRY_ORG" };

  const release = String(input.release ?? "").trim();
  if (!release) return { enabled: false, reason: "missing SENTRY_RELEASE" };

  const requireCi = input.requireCi !== false;
  if (requireCi) {
    const isCi = String(input.env.GITHUB_ACTIONS ?? "").toLowerCase() === "true";
    const explicit = String(input.env.SENTRY_RELEASE_TRACKING ?? input.env.HAPPIER_SENTRY_RELEASE_TRACKING ?? "").trim();
    const explicitlyEnabled = explicit === "1" || explicit.toLowerCase() === "true";
    if (!isCi && !explicitlyEnabled) return { enabled: false, reason: "not in CI and tracking not enabled" };
  }

  return { enabled: true };
}

/**
 * @param {{ env: NodeJS.ProcessEnv }} input
 * @returns {{ org: string; url: string; deployEnvironment: string; setCommitsAuto: boolean }}
 */
export function resolveSentryReleaseTrackingConfig(input) {
  const org = String(input.env.SENTRY_ORG ?? input.env.HAPPIER_SENTRY_ORG ?? "happier-devs").trim() || "happier-devs";
  const url = String(input.env.SENTRY_URL ?? input.env.HAPPIER_SENTRY_URL ?? "https://sentry.io/").trim() || "https://sentry.io/";
  const deployEnvironment = String(input.env.SENTRY_DEPLOY_ENVIRONMENT ?? input.env.HAPPIER_SENTRY_DEPLOY_ENVIRONMENT ?? "").trim();
  const setCommitsAuto =
    (String(input.env.SENTRY_SET_COMMITS_AUTO ?? input.env.HAPPIER_SENTRY_SET_COMMITS_AUTO ?? "").trim() || "true").toLowerCase() !== "false";
  return {
    org,
    url,
    deployEnvironment,
    setCommitsAuto,
  };
}

/**
 * @param {{
 *   repoRoot: string;
 *   env: NodeJS.ProcessEnv;
 *   release: string;
 *   channel: 'stable' | 'preview';
 *   dryRun: boolean;
 *   run: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'pipe' }) => void;
 * }} input
 * @returns {{ status: 'tracked' | 'skipped'; reason?: string }}
 */
export function maybeTrackSentryRelease(input) {
  if (input.dryRun) return { status: "skipped", reason: "dry run" };
  const should = shouldTrackSentryRelease({ env: input.env, release: input.release });
  if (!should.enabled) return { status: "skipped", reason: should.reason };

  const cfg = resolveSentryReleaseTrackingConfig({ env: input.env });
  const projects = resolveSentryProjects(input.env);
  const environment = cfg.deployEnvironment || (input.channel === "stable" ? "production" : "preview");

  const sentryEnv = {
    ...input.env,
    SENTRY_ORG: cfg.org,
    SENTRY_URL: cfg.url,
  };

  const cli = resolveSentryCliPath({ repoRoot: input.repoRoot });
  const projectArgs = projects.flatMap((p) => ["--project", p]);

  // Create release (idempotent-ish: sentry-cli errors if it exists; we ignore that specific case).
  try {
    input.run(cli, ["releases", "new", input.release, ...projectArgs], { env: sentryEnv, stdio: "inherit" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) throw err;
  }

  if (cfg.setCommitsAuto) {
    // Associate commits for regressions → commits mapping.
    // `--ignore-missing` avoids failing when the repo isn't linked.
    try {
      input.run(cli, ["releases", "set-commits", input.release, "--auto", "--ignore-missing"], { env: sentryEnv, stdio: "inherit" });
    } catch {
      // best-effort; keep release tracking resilient
    }
  }

  // Finalize + deploy marker (best-effort).
  try {
    input.run(cli, ["releases", "finalize", input.release], { env: sentryEnv, stdio: "inherit" });
  } catch {
    // ignore
  }
  try {
    input.run(cli, ["releases", "deploys", input.release, "new", "-e", environment], { env: sentryEnv, stdio: "inherit" });
  } catch {
    // ignore
  }

  return { status: "tracked" };
}
