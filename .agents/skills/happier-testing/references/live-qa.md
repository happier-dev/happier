# Live QA infrastructure (moved from happier-testing SKILL.md)

`happier-testing` "Live Validation Gates" points here.

## QA-host browser

Sign in with `hstack dev-targets browser signin <agent-browser-session> --stack=<qa> [--cdp=<returned-cdp-http-url>]`, supplying the Account secret key on stdin; see [Stack command documentation](../../../../apps/docs/content/docs/hstack/dev-targets.mdx).

The dedicated QA-host browser owner launches Chromium with `--no-sandbox`, as approved for browsing Happier's own QA app. Agent-browser/Playwright attach to its returned CDP endpoint; keep this policy in `qa_browser.mjs` rather than adding launch flags in individual lanes. Use a TTY-backed foreground tool handle and verify browser/profile/forward cleanup after SIGINT; cancelling a non-TTY checkout launcher can leave the actual command running.

For an explicitly authorized controlled QA stack, use `dev-targets browser start <lane-session> --stack=<qa-stack> --url=<qa-ui-url>` to select the QA pool host with the greatest observed unreserved memory independently of the daemon pin. Use its returned CDP endpoint and origin-preserving browser-facing `url` with controller-local agent-browser or Playwright; the browser owner supplies a lane-owned loopback reverse SOCKS route to the controller ingress, including canonical Home addresses adopted after restore. Retain the foreground owner handle and terminate it after the round to clean up the browser/profile and forwards. Provision through `dev-targets qa setup <target> --stack=<qa-stack>` when needed. The controlled-stack skill owns the stack and pin lifecycle. An unusable pool or unavailable selected host fails closed without a controller-local browser. This does not authorize creating a dedicated stack for ordinary QA or changing another stack's Machine.

## Dedicated controlled-stack routing

Do not create a dedicated QA stack merely because testing or QA is requested. When a human explicitly requests a dedicated, isolated, stable, controlled, snapshot-backed, or manual-restart QA stack, invoke `.agents/skills/happier-controlled-stack-qa` and let it own provisioning, reuse, runtime identity, reload boundaries, borrowed Expo, and teardown. That skill requires one remembered stack per agent session unless the human explicitly requests multiple stacks.

## Blank development web startup

- Separate HTML delivery, bundle delivery/evaluation, React commit, rendered app content, and authenticated Home connectivity. Require the expected origin/path, nonempty app content, and a screenshot; root children alone can be Expo development chrome. A successful `open`, HTTP 200, or `main` console message does not close readiness.
- Install error/unhandled-rejection capture and a React commit hook before navigation. Keep the browser handle and target identity through the readiness wait and subsequent probes. If an automation daemon exits, its replacement `about:blank` page is a lost diagnostic target, not the application's rendered output.
- If native browser automation loses its target or CDP responsiveness, compare once with a persistent context using the repository's existing Playwright dependency and the same Chrome executable, URL, and read-only authentication state. Attach later CLI probes to that browser's explicit CDP endpoint and page target rather than launching another browser. Do not save or print the supplied credential state.
- Wait for the required app surface, not `networkidle`: Home/socket traffic and background workers may continue after first paint. Preserve request failures with URL paths, timestamps, console errors, and the loaded bundle response. Record authentication separately from rendering; an authenticated shell can render while its Home is unreachable.
- For `ERR_EMPTY_RESPONSE`, connection resets, or failed lazy-route chunks, correlate the exact request time with the stack's remote Expo log and the forward's listening process. Metro heap exhaustion can leave the SSH listener alive while its upstream is down; an app recovery boundary then reports the failed chunk fetch. Stack health and an earlier successful bundle do not refute that failure.
- Inspect `apps/stack/scripts/utils/expo/expoNodeHeapEnv.mjs` before proposing a heap change. It owns the Expo heap policy and its existing override. Do not replace an out-of-memory diagnosis with a guessed larger limit or longer readiness timeout; distinguish the verified crash from an unmeasured allocation/retention cause, and respect the task's lifecycle authority.

