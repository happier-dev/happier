/**
 * Copy for /features/terminal.
 *
 * SCOPE. This page owns EVALUATION intent: can Happier do this, for which
 * agents, and what is the catch. It does not own procedure — docs.happier.dev
 * has the step list and this page links to it exactly once. If you find
 * yourself writing "1. Open Settings", you are on the wrong page.
 *
 * Verification anchors (happier-dev/happier @ v0.2, the shipped tree):
 *   local vs remote control      apps/docs/content/docs/features/attach-to-session.mdx:142-152
 *   which agents                 packages/agents/src/manifest.ts — `localControl`
 *                                  claude  { supported, topology: 'exclusive', attachStrategy: 'tmux' }
 *                                  codex   { supported, topology: 'exclusive', attachStrategy: 'tmux' }
 *                                  opencode{ supported, topology: 'shared',    attachStrategy: 'provider_attach' }
 *   pending queue behaviour      apps/docs/content/docs/features/pending-queue.mdx:86-92
 *   permission bridge default    apps/docs/content/docs/providers/claude.mdx:207
 *   Windows session modes        apps/docs/content/docs/features/attach-to-session.mdx:74-84
 *   embedded terminal            apps/docs/content/docs/features/embedded-terminal.mdx
 *   `happier <agent>` subcommands apps/cli/src/cli/commandRegistry.ts:42 —
 *                                  every backend registers its `cliSubcommand`
 *
 * CLAUDE UNIFIED — where every sentence in CLAUDE_UNIFIED comes from, all of it
 * read in the shipped tree rather than inferred:
 *   it runs the real CLI            apps/cli/src/backends/claude/unifiedTerminal/
 *                                     buildClaudeUnifiedTerminalSpawn.ts resolves
 *                                     the `claude` binary and spawns it
 *   in a shared terminal host       integrations/terminalHost/defaultRegistry.ts
 *                                     registers exactly two adapters, tmux and
 *                                     the bundled zellij; resolveTerminalHost.ts:66-80
 *                                     has no Windows adapter to resolve to, which
 *                                     is why this says macOS and Linux
 *   both ends live at once          backends/claude/localControl/
 *                                     buildClaudeAgentState.ts:31-48 —
 *                                     topology 'shared', remoteWritable true,
 *                                     inFlightSteerSupported true
 *   the app types into that TUI     unifiedTerminal/createClaudeUnifiedPromptInjector.ts
 *                                     with a draft guard so it cannot type over
 *                                     what a human is mid-way through writing
 *   it is OFF by default            features/featureLocalPolicy.ts:14-19 ("unified
 *                                     is itself off by default"), and
 *                                     backends/claude/remote/normalizeClaudeRemoteMode.ts:9-17
 *                                     falls through to the Agent SDK
 *   the setting's own words         apps/ui/sources/text/translations/en.ts:3619-3652
 *                                     — "Unified terminal runtime", "Drive Claude
 *                                     through the terminal session so the UI and
 *                                     terminal share one Claude Code run",
 *                                     "Use tmux when available, otherwise use
 *                                     bundled zellij"
 *   steer vs interrupt             apps/docs/content/docs/features/steering.mdx
 *                                     — steering updates the running turn;
 *                                     interrupting aborts it and sends a new one
 *
 * The Agent SDK sentence is attributed to Anthropic on purpose. Their streaming
 * input documentation describes queued messages that "process sequentially, with
 * ability to interrupt" — that is their description of their own runtime, and it
 * is the honest way to draw the line without claiming to have audited an SDK we
 * do not ship. Nothing on this page goes near why the unified runtime was built.
 */

export type ControlRow = {
    id: string;
    agent: string;
    topology: string;
    attach: string;
    note: string;
};

/**
 * The three agents whose sessions can move between your terminal and the app.
 *
 * Deliberately three rows and not thirteen. `localControl` is declared by a few
 * more entries in the manifest, but only these three declare an attach strategy
 * that exists, and a table row for an agent whose attach strategy is
 * `unsupported` would be a row that reads as a yes.
 */
export const CONTROL_ROWS: ReadonlyArray<ControlRow> = [
    {
        id: 'claude',
        agent: 'Claude Code',
        topology: 'One at a time, or both',
        attach: 'tmux',
        note: 'On the default runtime, a message you send from the app while you are driving the terminal waits in the queue instead of being typed into your session; permission prompts are still forwarded to the app, and that bridge is on by default. The unified terminal runtime is the “both” case — see below.',
    },
    {
        id: 'codex',
        agent: 'Codex',
        topology: 'One at a time',
        attach: 'tmux',
        note: 'Same exclusivity. Happier waits for the local turn to finish, abort, or exit before it takes the session back and delivers whatever you queued.',
    },
    {
        id: 'opencode',
        agent: 'OpenCode',
        topology: 'Both at once',
        attach: 'OpenCode’s own attach',
        note: 'Shared local control with nothing to enable first: the app stays writable while the OpenCode TUI is attached, and no multiplexer is involved.',
    },
];

/** The load-bearing paragraphs, in the order the argument needs them. */
export const TERMINAL_INTRO: ReadonlyArray<string> = [
    'If you live in a terminal, most writing about running coding agents from a phone reads like a request to stop. That is a fair thing to refuse. Nothing about a phone screen is better than tmux and a keyboard for the part of the work you are actually good at.',
    'So the claim here is narrower. A Happier session is one session with two front ends: a terminal on the computer doing the work is one of them, the app on your phone is the other. Switching between them does not start anything new — the session id, the transcript, the permission mode and the queued messages are all the same objects on the other side of the switch.',
];

/**
 * The Claude-specific section: what the unified terminal runtime is, and the
 * distinction it turns on.
 *
 * Kept short and kept precise. The whole value of the claim is the difference
 * between steering and interrupting, and a paragraph that blurs them is worth
 * less than no paragraph at all.
 */
export const CLAUDE_UNIFIED_HEADING = 'Drive Claude Code inside its own terminal';

export const CLAUDE_UNIFIED: ReadonlyArray<string> = [
    'Steering and interrupting are different moves. Interrupting stops the turn that is running and starts another one from your message. Steering adds to the turn that is running — the work carries on, now knowing the thing you just told it. Both are useful, and the second one is the one you want when you look up from your phone and realise it is about to rename the wrong file.',
    'Anthropic documents the Agent SDK’s streaming input as queued messages that process sequentially, with the ability to interrupt. That is the runtime Happier uses for Claude Code by default, and for most sessions it is the right one. Claude Code’s own terminal takes the other kind of message: type while it is working and the instruction joins the work already in flight.',
    'The unified terminal runtime is how the app reaches that. Happier starts the real `claude` TUI inside a shared terminal host — tmux where you have it, otherwise the zellij Happier bundles — streams that terminal to every device you are signed in on, and types what you send from the app into the same composer you would have typed into yourself. One Claude Code process, one session, two keyboards on it. You can be typing in the TUI at your desk while the same session is answered from a phone, and neither end locks the other out.',
    'It is off until you turn it on, in the Claude Code provider settings. It needs tmux or the bundled zellij, so today that means macOS and Linux; on Windows the CLI tells you to use WSL2 rather than starting something it cannot verify. And when the terminal is in a state where typing would be unsafe — a dialog is open, or you are part-way through a line of your own — Happier holds your message instead of typing over you.',
];

export const TERMINAL_MOVES: ReadonlyArray<{ id: string; title: string; body: string }> = [
    {
        id: 'terminal-first',
        title: 'Start in the terminal',
        body: 'Run `happier` in a repository and you get the default agent with the app attached. `happier codex`, `happier opencode`, `happier gemini` and the rest of the registry are the same thing pointed at a different CLI. You are in your own terminal, in your own shell, with your own aliases; the app is watching.',
    },
    {
        id: 'app-first',
        title: 'Start in the app, finish in the terminal',
        body: 'Start a session from your phone on the train, then run `happier attach <session-id>` when you sit down. With no id it opens a picker of the sessions running on this computer, and marks the ones it cannot attach to with the reason rather than hiding them.',
    },
    {
        id: 'back',
        title: 'Go back the other way',
        body: 'Taking local control starts from the terminal; handing it back can be asked for from the app. Happier will wait for the current terminal turn to reach a safe stopping point first, because forcing a prompt into a busy TUI is how you lose the work it was in the middle of.',
    },
    {
        id: 'in-app',
        title: 'Or never open a terminal at all',
        body: 'The app has a real one built in — a live shell on the connected computer, docked to the bottom panel, the sidebar or the details panel, surviving a page refresh and keeping the same shell as you move it around. It is the same terminal transport the app uses to run provider logins.',
    },
];

/**
 * The catch. Every feature page needs one and this is the honest version: tmux
 * has to be on BEFORE the session starts, which is the single most common way
 * this workflow disappoints someone on their first try.
 */
export const TERMINAL_CATCH: ReadonlyArray<string> = [
    'The one that catches people: on macOS and Linux, attaching to a Claude Code or Codex session started from the app needs tmux integration enabled before that session starts. Turn it on after the fact and the session already running is not attachable — it was never launched inside tmux to begin with. You also have to attach from the same computer that owns the session and the same account that started it.',
    'Windows does not use tmux. A session there is launched Hidden, in Windows Terminal, or in a console, and `happier attach` focuses the host that already exists instead of reattaching to a multiplexer. That is a per-machine and per-session choice, not a global one.',
    'The embedded terminal needs your daemon running and connected for the computer you are targeting. If the daemon is offline, Happier shows an error state rather than a shell that silently does nothing.',
];

/** The one link this page makes into the docs, labelled as a configuration reference. */
export const TERMINAL_DOCS_URL = 'https://docs.happier.dev/features/attach-to-session';
