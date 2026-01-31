import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { isTty } from './utils/cli/wizard.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { createStepPrinter, runCommandLogged } from './utils/cli/progress.mjs';
import { createFileLogForwarder } from './utils/cli/log_forwarder.mjs';
import { assertCliPrereqs } from './utils/cli/prereqs.mjs';
import { decidePrAuthPlan } from './utils/auth/guided_pr_auth.mjs';
import { assertExpoWebappBundlesOrThrow, guidedStackAuthLoginNow, resolveStackWebappUrlForAuth } from './utils/auth/stack_guided_login.mjs';
import { preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { run } from './utils/proc/proc.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { sanitizeStackName } from './utils/stack/names.mjs';
import { getStackRuntimeStatePath, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { readEnvObjectFromFile } from './utils/env/read.mjs';
import { checkDaemonState, startLocalDaemonWithAuth } from './daemon.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveMobileQrPayload } from './utils/mobile/dev_client_links.mjs';
import { renderQrAscii } from './utils/ui/qr.mjs';
import { inferPrStackBaseName } from './utils/stack/pr_stack_name.mjs';
import { bold, cyan, dim, green } from './utils/ui/ansi.mjs';

function pickReviewerMobileSchemeEnv(env) {
  // For review-pr flows, reviewers typically have the standard Happier dev build on their phone,
  // so default to the canonical `happier://` scheme unless the user explicitly configured one.
  // If the user explicitly set a review-specific override, honor it.
  const reviewOverride = (env.HAPPIER_STACK_REVIEW_MOBILE_SCHEME ?? '').toString().trim();
  if (reviewOverride) {
    return { ...env, HAPPIER_STACK_MOBILE_SCHEME: reviewOverride };
  }

  // In sandbox review flows, keep things predictable and avoid relying on any global per-machine overrides.
  if (isSandboxed()) {
    return { ...env, HAPPIER_STACK_MOBILE_SCHEME: 'happier' };
  }

  // Non-sandbox: keep existing behavior unless nothing is configured at all.
  const explicit =
    (env.HAPPIER_STACK_MOBILE_SCHEME ?? env.HAPPIER_STACK_DEV_CLIENT_SCHEME ?? '')
      .toString()
      .trim();
  if (explicit) return env;
  return { ...env, HAPPIER_STACK_MOBILE_SCHEME: 'happier' };
}

async function printReviewerStackSummary({ rootDir, stackName, env, wantsMobile }) {
  try {
    const runtimeStatePath = getStackRuntimeStatePath(stackName);
    // Wait briefly for Expo metadata to land in stack.runtime.json (it can be published slightly
    // after the server /health check passes, especially after a restart).
    const deadline = Date.now() + 20_000;
    let st = await readStackRuntimeStateFile(runtimeStatePath);
    while (Date.now() < deadline) {
      const hasExpo = Boolean(st?.expo && typeof st.expo === 'object' && Number(st.expo.port) > 0);
      if (hasExpo) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
      // eslint-disable-next-line no-await-in-loop
      st = await readStackRuntimeStateFile(runtimeStatePath);
    }
    const baseDir = resolveStackEnvPath(stackName, env).baseDir;
    const envPath = resolveStackEnvPath(stackName, env).envPath;

    const serverPort = Number(st?.ports?.server);
    const backendPort = Number(st?.ports?.backend);
    const uiPort = Number(st?.expo?.webPort ?? st?.expo?.port);
    const mobilePort = Number(st?.expo?.mobilePort ?? st?.expo?.port);
    const runnerLog = String(st?.logs?.runner ?? '').trim();
    const runnerPid = Number(st?.ownerPid);
    const serverPid = Number(st?.processes?.serverPid);
    const expoPid = Number(st?.processes?.expoPid);

    const internalServerUrl = Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '';
    const uiUrlRaw = Number.isFinite(uiPort) && uiPort > 0 ? `http://localhost:${uiPort}` : '';
    const uiUrl = uiUrlRaw ? await preferStackLocalhostUrl(uiUrlRaw, { stackName, env }) : '';

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Review details'));
    // eslint-disable-next-line no-console
    console.log(`${dim('Stack:')} ${cyan(stackName)}`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Env:')}   ${envPath}`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Dir:')}   ${baseDir}`);
    if (Number.isFinite(runnerPid) && runnerPid > 1) {
      // eslint-disable-next-line no-console
      console.log(`${dim('Runner:')} pid=${runnerPid}${Number.isFinite(serverPid) && serverPid > 1 ? ` serverPid=${serverPid}` : ''}${Number.isFinite(expoPid) && expoPid > 1 ? ` expoPid=${expoPid}` : ''}`);
    }
    if (runnerLog) {
      // eslint-disable-next-line no-console
      console.log(`${dim('Logs:')}  ${runnerLog}`);
    }

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Ports'));
    if (Number.isFinite(serverPort) && serverPort > 0) {
      // eslint-disable-next-line no-console
      console.log(`- ${dim('server')}:  ${serverPort}${internalServerUrl ? ` (${internalServerUrl})` : ''}`);
    }
    if (Number.isFinite(backendPort) && backendPort > 0) {
      // eslint-disable-next-line no-console
      console.log(`- ${dim('backend')}: ${backendPort}`);
    }
    if (Number.isFinite(uiPort) && uiPort > 0) {
      // eslint-disable-next-line no-console
      console.log(`- ${dim('web UI')}:  ${uiPort}${uiUrl ? ` (${uiUrl})` : ''}`);
    }
    if (wantsMobile && Number.isFinite(mobilePort) && mobilePort > 0) {
      // eslint-disable-next-line no-console
      console.log(`- ${dim('mobile')}:  ${mobilePort} (Metro)`);
    }

    // Prefer the Metro port recorded by Expo; fall back to the web UI port if needed.
    const metroPort = Number.isFinite(mobilePort) && mobilePort > 0 ? mobilePort : Number.isFinite(uiPort) && uiPort > 0 ? uiPort : null;

    if (wantsMobile && Number.isFinite(metroPort) && metroPort > 0) {
      const payload = resolveMobileQrPayload({ env, port: metroPort });
      const qr = await renderQrAscii(payload.payload, { small: true });

      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(bold('Mobile (Expo dev-client)'));
      if (payload.metroUrl) {
        // eslint-disable-next-line no-console
        console.log(`- ${dim('Metro')}:  ${payload.metroUrl}`);
      }
      if (payload.scheme) {
        // eslint-disable-next-line no-console
        console.log(`- ${dim('Scheme')}: ${payload.scheme}://`);
      }
      if (payload.deepLink) {
        // eslint-disable-next-line no-console
        console.log(`- ${dim('Link')}:   ${payload.deepLink}`);
      }
      if (qr.ok && qr.lines.length) {
        // eslint-disable-next-line no-console
        console.log('');
        // eslint-disable-next-line no-console
        console.log(bold('Scan this QR code with your Happy dev build:'));
        // eslint-disable-next-line no-console
        console.log(qr.lines.join('\n'));
      } else if (!qr.ok) {
        // eslint-disable-next-line no-console
        console.log(dim(`(QR unavailable: ${qr.error || 'unknown error'})`));
      }
    }

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(green('✓ Ready'));
    // eslint-disable-next-line no-console
    console.log(dim('Tip: press Ctrl+C when you’re done to stop the stack and clean up the sandbox.'));
  } catch {
    // best-effort
  }
}

function detectBestAuthSource() {
  const devAuthEnvExists = existsSync(resolveStackEnvPath('dev-auth').envPath);
  const devAuthAccessKey = join(resolveStackEnvPath('dev-auth').baseDir, 'cli', 'access.key');
  const mainAccessKey = join(resolveStackEnvPath('main').baseDir, 'cli', 'access.key');

  const hasDevAuth = devAuthEnvExists && existsSync(devAuthAccessKey);
  const hasMain = existsSync(mainAccessKey);

  if (hasDevAuth) return { from: 'dev-auth', hasAny: true };
  if (hasMain) return { from: 'main', hasAny: true };
  return { from: 'main', hasAny: false };
}

function detectLinkDefault() {
  const rawLink = (process.env.HAPPIER_STACK_AUTH_LINK ?? '').toString().trim();
  if (rawLink) return rawLink !== '0';
  const rawMode = (process.env.HAPPIER_STACK_AUTH_MODE ?? '').toString().trim().toLowerCase();
  if (rawMode) return rawMode === 'link';
  // Default for setup-pr: prefer reuse/symlink to avoid stale creds and reduce re-login friction.
  return true;
}

async function runNodeScript({ rootDir, rel, args = [], env = process.env }) {
  await run(process.execPath, [join(rootDir, rel), ...args], { cwd: rootDir, env });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argvRaw = process.argv.slice(2);
  const sep = argvRaw.indexOf('--');
  const argv = sep >= 0 ? argvRaw.slice(0, sep) : argvRaw;
  const forwarded = sep >= 0 ? argvRaw.slice(sep + 1) : [];

  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const interactive = isTty() && !json;
  const verbosity = getVerbosityLevel(process.env);
  const quietUi = interactive && verbosity === 0;

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'hapsta tools setup-pr --repo=<pr-url|number> [--name=<stack>] [--server-flavor=light|full] [--dev|--start] [--mobile] [--deps=none|link|install|link-or-install] [--forks|--upstream] [--seed-auth|--no-seed-auth] [--copy-auth-from=<stack>] [--link-auth|--copy-auth] [--update] [--force] [--json] [-- <stack dev/start args...>]',
      },
      text: [
        '[setup-pr] usage:',
        '  hapsta tools setup-pr --repo=<pr-url|number> [--dev]',
        '',
        'What it does (idempotent):',
        '- ensures hapsta home exists (init)',
        '- bootstraps/clones missing repos (upstream by default)',
        '- creates or reuses a PR stack and checks out the PR worktree',
        '- optionally seeds auth (best available source: dev-auth → main)',
        '- starts the stack (dev by default)',
        '',
        'Updating when the PR changes:',
        '- re-run the same command; it will fast-forward PR worktrees when possible',
        '- if the PR was force-pushed, add --force',
        '',
        'example:',
        '  hapsta tools setup-pr \\',
        '    --repo=https://github.com/happier-dev/happier/pull/123 \\',
        '    --dev',
      ].join('\n'),
    });
    return;
  }

  await assertCliPrereqs({ git: true, yarn: true });

  const prRepo = (kv.get('--repo') ?? kv.get('--pr') ?? '').trim();
  const legacyHappy = (kv.get('--happy') ?? '').trim();
  if (legacyHappy) {
    throw new Error('[setup-pr] use --repo=<pr-url|number> (the old --happy flag has been removed)');
  }
  if (!prRepo) {
    throw new Error('[setup-pr] missing PR input. Provide --repo=<pr-url|number>.');
  }
  for (const legacy of ['--happy-cli', '--happy-server', '--happy-server-light']) {
    const v = (kv.get(legacy) ?? '').trim();
    if (v) {
      throw new Error(`[setup-pr] legacy split-repo flag is not supported anymore: ${legacy}\nFix: use --repo=<pr-url|number>`);
    }
  }

  const wantsDev = flags.has('--dev') || (!flags.has('--start') && !flags.has('--prod'));
  const wantsStart = flags.has('--start') || flags.has('--prod');
  if (wantsDev && wantsStart) {
    throw new Error('[setup-pr] choose either --dev or --start (not both)');
  }
  const repoSourceFlag = flags.has('--upstream') ? '--upstream' : flags.has('--forks') ? '--forks' : null;
  const wantsMobile = (flags.has('--mobile') || flags.has('--with-mobile')) && !flags.has('--no-mobile');
  // Worktree dependency strategy:
  // - For dev flows (review-pr/setup-pr), prefer reusing base checkout node_modules to avoid reinstalling in worktrees.
  // - Allow override via --deps=none|link|install|link-or-install.
  const depsModeArg = (kv.get('--deps') ?? '').trim();
  const depsMode = depsModeArg || (wantsDev ? 'link-or-install' : 'none');

  const stackNameRaw = (kv.get('--name') ?? '').trim();
  const stackName = stackNameRaw
    ? sanitizeStackName(stackNameRaw)
    : inferPrStackBaseName({ happy: prRepo, happyCli: '', server: '', serverLight: '', fallback: 'pr' });

  // Determine server flavor for bootstrap and stack creation.
  const serverFlavorFromArg = (kv.get('--server-flavor') ?? '').trim().toLowerCase();
  const serverFromArg = (kv.get('--server') ?? '').trim();
  const serverComponent =
    serverFlavorFromArg === 'full'
      ? 'happy-server'
      : serverFlavorFromArg === 'light'
        ? 'happy-server-light'
        : serverFromArg || 'happy-server-light';
  const bootstrapServer = serverComponent === 'happy-server' ? 'both' : 'happy-server-light';

  // Auth defaults (avoid prompts; setup-pr should be low-friction).
  // Note: these may be updated below (sandbox prompt), so keep them mutable.
  let seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  let authFrom = (kv.get('--copy-auth-from') ?? '').trim();
  let linkAuth = flags.has('--link-auth') ? true : flags.has('--copy-auth') ? false : null;

  // Disallow "legacy" auth seeding in setup-pr flows:
  // We can't reliably seed local DB Account rows from a remote/production Happy install,
  // so this leads to broken stacks. Use guided login instead.
  if (authFrom && authFrom.toLowerCase() === 'legacy') {
    throw new Error('[setup-pr] --copy-auth-from=legacy is not supported. Use guided login (no seeding) instead.');
  }

  // Re-read flags after optional prompt mutation.
  seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  authFrom = (kv.get('--copy-auth-from') ?? '').trim();
  linkAuth = flags.has('--link-auth') ? true : flags.has('--copy-auth') ? false : null;

  // If this PR stack already has credentials, do not prompt or override it.
  const stackAlreadyAuthed = (() => {
    try {
      const { baseDir, envPath } = resolveStackEnvPath(stackName);
      if (!existsSync(envPath)) return false;
      return existsSync(join(baseDir, 'cli', 'access.key'));
    } catch {
      return false;
    }
  })();

  // Centralized guided auth decision (prompt early, before noisy install logs).
  // In non-sandbox mode we still guide: offer reusing dev-auth/main first, otherwise guided login.
  const sandboxNoGlobal = isSandboxed() && !sandboxAllowsGlobalSideEffects();
  if (sandboxNoGlobal && (seedAuthFlag === true || authFrom)) {
    throw new Error(
      '[setup-pr] auth seeding is disabled in sandbox mode.\n' +
        'Reason: it reuses global machine state (other stacks) and breaks sandbox isolation.\n' +
        'Use guided login instead, or set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
    );
  }

  let plan = stackAlreadyAuthed
    ? { mode: 'existing' }
    : await decidePrAuthPlan({
        interactive,
        seedAuthFlag,
        explicitFrom: authFrom,
        defaultLoginNow: true,
      });
  if (sandboxNoGlobal && plan?.mode === 'seed') {
    // Keep sandbox runs isolated by default.
    plan = { mode: 'login', loginNow: true, reason: 'sandbox_no_global' };
  }

  const best = detectBestAuthSource();
  const effectiveSeedAuth =
    plan.mode === 'existing'
      ? false
      : plan.mode === 'seed'
        ? true
        : plan.mode === 'login'
          ? false
          : seedAuthFlag != null
            ? seedAuthFlag
            : best.hasAny;
  const effectiveAuthFrom = plan.mode === 'seed' ? plan.from : authFrom || best.from;
  const effectiveLinkAuth = plan.mode === 'seed' ? Boolean(plan.link) : linkAuth != null ? linkAuth : detectLinkDefault();

  // Sandbox default: no cross-stack auth reuse unless explicitly allowed.
  const sandboxEffectiveSeedAuth = sandboxNoGlobal ? false : effectiveSeedAuth;

  // If we're going to guide the user through login, start in background first (even in verbose mode)
  // so auth prompts aren't buried in runner logs.
  const needsAuthFlow = interactive && !stackAlreadyAuthed && !sandboxEffectiveSeedAuth && plan.mode === 'login' && plan.loginNow;
  let stackStartEnv = needsAuthFlow
    ? {
        ...process.env,
        // Hint to the dev runner that it should start the Expo web UI early (before daemon auth),
        // so guided login can open the correct UI origin (not the server port).
        HAPPIER_STACK_AUTH_FLOW: '1',
      }
    : process.env;
  if (wantsMobile) {
    stackStartEnv = pickReviewerMobileSchemeEnv(stackStartEnv);
  }
  // (No extra messaging here; review-pr prints the up-front explanation + enter-to-proceed gate.)

  // 1) Ensure happy-stacks home is initialized (idempotent).
  // 2) Bootstrap component repos and deps (idempotent; clones only if missing).
  if (quietUi) {
    const baseLogDir = join(process.env.HAPPIER_STACK_HOME_DIR ?? join(homedir(), '.happier-stack'), 'logs', 'setup-pr');
    const initLog = join(baseLogDir, `init.${Date.now()}.log`);
    const installLog = join(baseLogDir, `install.${Date.now()}.log`);
    try {
      await runCommandLogged({
        label: `init hapsta home${isSandboxed() ? ' (sandbox)' : ''}`,
        cmd: process.execPath,
        args: [join(rootDir, 'scripts', 'init.mjs'), '--no-bootstrap'],
        cwd: rootDir,
        env: process.env,
        logPath: initLog,
        quiet: true,
        showSteps: true,
      });
      await runCommandLogged({
        label: `install/clone components${isSandboxed() ? ' (sandbox)' : ''}`,
        cmd: process.execPath,
        args: [
          join(rootDir, 'scripts', 'install.mjs'),
          ...(repoSourceFlag ? [repoSourceFlag] : []),
          '--clone',
          `--server=${bootstrapServer}`,
          ...(wantsDev ? ['--no-ui-build'] : []),
          // Sandbox dev: avoid wasting time installing base deps we won't run directly.
          ...(isSandboxed() && wantsDev ? ['--no-ui-deps'] : []),
        ],
        cwd: rootDir,
        env: process.env,
        logPath: installLog,
        quiet: true,
        showSteps: true,
      });
    } catch (e) {
      const logPath = e?.logPath ? String(e.logPath) : null;
      console.error('[setup-pr] failed during setup.');
      if (logPath) {
        console.error(`[setup-pr] log: ${logPath}`);
      }
      if (e?.stderr) {
        console.error(String(e.stderr).trim());
      } else if (e instanceof Error) {
        console.error(e.message);
      } else {
        console.error(String(e));
      }
      process.exit(1);
    }
  } else {
    await runNodeScript({ rootDir, rel: 'scripts/init.mjs', args: ['--no-bootstrap'] });
    await runNodeScript({
      rootDir,
      rel: 'scripts/install.mjs',
      args: [
        ...(repoSourceFlag ? [repoSourceFlag] : []),
        '--clone',
        `--server=${bootstrapServer}`,
        ...(wantsDev ? ['--no-ui-build'] : []),
        ...(isSandboxed() && wantsDev ? ['--no-ui-deps'] : []),
      ],
    });
  }

  // 3) Create/reuse the PR stack and wire worktrees.
  // Start Expo with all requested capabilities from the beginning to avoid stop/restart churn.
  const startMobileNow = wantsMobile;
  const userDisabledDaemon = forwarded.includes('--no-daemon');
  const forwardedEffective =
    needsAuthFlow && !userDisabledDaemon && !forwarded.includes('--no-daemon')
      ? [...forwarded, '--no-daemon']
      : forwarded;
  const injectedNoDaemon = needsAuthFlow && !userDisabledDaemon && forwardedEffective.includes('--no-daemon');
  const stackArgs = [
    'pr',
    stackName,
    `--repo=${prRepo}`,
    `--server=${serverComponent}`,
    '--reuse',
    ...(depsMode ? [`--deps=${depsMode}`] : []),
    ...(flags.has('--update') ? ['--update'] : []),
    ...(flags.has('--force') ? ['--force'] : []),
    ...(sandboxEffectiveSeedAuth
      ? ['--seed-auth', `--copy-auth-from=${effectiveAuthFrom}`, ...(effectiveLinkAuth ? ['--link-auth'] : [])]
      : ['--no-seed-auth']),
    ...(wantsDev ? ['--dev'] : ['--start']),
    ...(startMobileNow ? ['--mobile'] : []),
    ...(((quietUi && !json) || needsAuthFlow) ? ['--background'] : []),
    ...(json ? ['--json'] : []),
  ];
  if (forwardedEffective.length) {
    stackArgs.push('--', ...forwardedEffective);
  }
  if (quietUi) {
    const baseLogDir = join(process.env.HAPPIER_STACK_HOME_DIR ?? join(homedir(), '.happier-stack'), 'logs', 'setup-pr');
    const stackLog = join(baseLogDir, `stack-pr.${Date.now()}.log`);
    await runCommandLogged({
      label: `start PR stack${isSandboxed() ? ' (sandbox)' : ''}`,
      cmd: process.execPath,
      args: [join(rootDir, 'scripts', 'stack.mjs'), ...stackArgs],
      cwd: rootDir,
      env: stackStartEnv,
      logPath: stackLog,
      quiet: true,
      showSteps: true,
    }).catch((e) => {
      const logPath = e?.logPath ? String(e.logPath) : stackLog;
      console.error('[setup-pr] failed to start PR stack.');
      console.error(`[setup-pr] log: ${logPath}`);
      process.exit(1);
    });
  } else {
    await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: stackArgs, env: stackStartEnv });
  }

  // Sandbox UX: if we won't run the guided login flow, explicitly tell the user we're now in "keepalive"
  // mode and how to exit/cleanup. Otherwise it can look like the command "hung".
  if (isSandboxed() && interactive && !json && !needsAuthFlow) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('[setup-pr] Stack is running in the sandbox.');
    // eslint-disable-next-line no-console
    console.log('[setup-pr] Press Ctrl+C when you’re done to stop and delete the sandbox.');
  }

  // Guided auth flow:
  // If the user chose "login now", we start in background (quiet mode) then perform login in the foreground.
  // Sandbox: keep this process alive so review-pr can clean up on exit.
  // Non-sandbox: after login, restart dev/start in the foreground so logs follow as usual.
  if (needsAuthFlow) {
    // eslint-disable-next-line no-console
    console.log('');
    if (interactive) {
      // In verbose mode, tail the runner log so users can debug Expo/auth issues,
      // but pause forwarding during the guided login prompts (keeps instructions readable).
      let forwarder = null;
      if (!json && verbosity > 0) {
        try {
          const runtimeStatePath = getStackRuntimeStatePath(stackName);
          const deadline = Date.now() + 10_000;
          let logPath = '';
          while (Date.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop
            const st = await readStackRuntimeStateFile(runtimeStatePath);
            logPath = String(st?.logs?.runner ?? '').trim();
            if (logPath) break;
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 200));
          }
          if (logPath) {
            forwarder = createFileLogForwarder({
              path: logPath,
              enabled: true,
              label: 'stack',
              startFromEnd: false,
            });
            await forwarder.start();
          }
        } catch {
          forwarder = null;
        }
      }

      const steps = createStepPrinter({ enabled: Boolean(process.stdout.isTTY && !json) });
      const label = 'prepare login (waiting for web UI)';
      steps.start(label);
      let webappUrl = '';
      try {
        // Use the same env overlay we used to start the stack in background (includes auth-flow markers).
        webappUrl = await resolveStackWebappUrlForAuth({ rootDir, stackName, env: stackStartEnv });
        // This can take a moment (first bundle compile / resolver errors).
        await assertExpoWebappBundlesOrThrow({ rootDir, stackName, webappUrl });
        steps.stop('✓', label);
      } catch (e) {
        // For guided login, failing to resolve the UI origin should fail closed (server URL fallback is misleading).
        steps.stop('x', label);
        try {
          await forwarder?.stop();
        } catch {
          // ignore
        }
        throw e;
      }

      try {
        forwarder?.pause();
        // We've already checked the web UI bundle above; skip repeating it here.
        await guidedStackAuthLoginNow({
          rootDir,
          stackName,
          env: { ...stackStartEnv, HAPPIER_STACK_AUTH_SKIP_BUNDLE_CHECK: '1' },
          webappUrl,
        });
      } finally {
        try {
          forwarder?.resume();
        } catch {
          // ignore
        }
        try {
          await forwarder?.stop();
        } catch {
          // ignore
        }
      }
    }
    // `guidedStackAuthLoginNow` already ran `stack auth <name> login` in interactive mode.
    if (!interactive) {
      await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['auth', stackName, '--', 'login'] });
    }

    // After guided login, start daemon now (unless the user explicitly disabled it).
    // This ensures the machine is registered and appears in the UI.
    if (injectedNoDaemon && !userDisabledDaemon) {
      const steps = createStepPrinter({ enabled: Boolean(process.stdout.isTTY && !json) });
      const label = 'start daemon (post-auth)';
      steps.start(label);
      try {
        const { envPath, baseDir } = resolveStackEnvPath(stackName, stackStartEnv);
        const stackEnv = await readEnvObjectFromFile(envPath);
        const mergedEnv = { ...process.env, ...stackEnv };

        const cliHomeDir =
          (mergedEnv.HAPPIER_STACK_CLI_HOME_DIR ?? '').toString().trim() ||
          join(baseDir, 'cli');
        const cliDir =
          (mergedEnv.HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI ?? '').toString().trim();
        if (!cliDir) {
          throw new Error('[setup-pr] post-auth daemon start failed: HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI is not set');
        }
        const cliBin = join(cliDir, 'bin', 'happy.mjs');

        const runtimeStatePath = getStackRuntimeStatePath(stackName);
        const st = await readStackRuntimeStateFile(runtimeStatePath);
        const serverPort = Number(st?.ports?.server);
        if (!Number.isFinite(serverPort) || serverPort <= 0) {
          throw new Error('[setup-pr] post-auth daemon start failed: could not resolve server port from stack.runtime.json');
        }
        const internalServerUrl = `http://127.0.0.1:${serverPort}`;
        const publicServerUrl = internalServerUrl;

        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: true,
          env: mergedEnv,
          stackName,
        });

        // Verify: daemon wrote state (best-effort wait).
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const s = checkDaemonState(cliHomeDir);
          if (s.status === 'running') break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 250));
        }
        steps.stop('✓', label);
      } catch (e) {
        steps.stop('x', label);
        throw e;
      }
    }

    if (isSandboxed()) {
      // Fall through to sandbox keepalive below.
    }

    // Re-attach logs in the foreground for the chosen mode.
    const restartArgs = [
      wantsDev ? 'dev' : 'start',
      stackName,
      '--restart',
      ...(wantsMobile ? ['--mobile'] : []),
      ...(forwarded.length ? ['--', ...forwarded] : []),
    ];
    // If the user explicitly asked for verbose, reattach; otherwise keep things quiet.
    if (verbosity > 0) {
      await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: restartArgs });
    }
    // Mobile is started up-front (in the initial stack pr start) so we don't need to restart here.
  }

  // After login (and after the optional mobile Metro start), print a clear summary so reviewers
  // have everything they need (URLs/ports/logs + QR) without needing verbose logs.
  if (interactive && !json) {
    await printReviewerStackSummary({ rootDir, stackName, env: stackStartEnv, wantsMobile });
  }

  // Sandbox: keep this process alive so review-pr stays running and can clean up on exit.
  // The stack runner continues in the background; `review-pr` will stop it on Ctrl+C.
  //
  // IMPORTANT:
  // Waiting on a Promise that only resolves on signals is NOT enough to keep Node alive; pending
  // Promises and signal handlers do not keep the event loop open. We must keep a ref'd handle.
  if (isSandboxed() && interactive && !json) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('[setup-pr] Stack is running in the sandbox.');
    // eslint-disable-next-line no-console
    console.log('[setup-pr] Press Ctrl+C when you’re done to stop and delete the sandbox.');

    await new Promise((resolvePromise) => {
      const interval = setInterval(() => {}, 1_000);
      const done = () => {
        clearInterval(interval);
        process.off('SIGINT', done);
        process.off('SIGTERM', done);
        resolvePromise();
      };
      process.on('SIGINT', done);
      process.on('SIGTERM', done);
    });
  }
}

main().catch((err) => {
  console.error('[setup-pr] failed:', err);
  process.exit(1);
});
