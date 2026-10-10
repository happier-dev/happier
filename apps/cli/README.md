# Happier

Code on the go — control AI coding agents from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g @happier-dev/cli
```

## Testing

```bash
yarn --cwd apps/cli test:unit
```

Integration (real process/fs/network style):

```bash
yarn --cwd apps/cli test:integration
```

Slow build+wiring validation suite:

```bash
yarn --cwd apps/cli test:slow
```

## Usage

### First-time authentication (recommended)

```bash
happier auth login
```

Recommended first run:
1. Choose the mobile option (recommended).
2. Scan the QR/deep link in the Happier mobile app.
3. If you already use Happier on another device, sign in with that same account.
4. If you are logged out, complete sign in/create account, then continue terminal approval (the app returns you automatically).

### Claude (default)

```bash
happier
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

### Multi-server quickstart

```bash
happier server add --name company --server-url https://api.company.example --webapp-url https://app.company.example --use
happier --server company auth login
```

### Gemini

```bash
happier gemini
```

Start a Gemini CLI session with remote control capabilities.

**First time setup:**
```bash
# Authenticate with Google
happier connect gemini
```

## Commands

### Agent Commands

Each agent Happier ships has a subcommand named after its CLI. `happier` with no
subcommand starts Claude Code.

| Command | Agent | Status |
| --- | --- | --- |
| `happier` / `happier claude` | Claude | Stable |
| `happier codex` | Codex | Stable |
| `happier opencode` | OpenCode | Stable |
| `happier gemini` | Gemini | Experimental |
| `happier auggie` | Auggie | Experimental |
| `happier qwen` | Qwen Code | Experimental |
| `happier kimi` | Kimi | Experimental |
| `happier kilo` | Kilo | Experimental |
| `happier kiro` | Kiro | Experimental |
| `happier cursor` | Cursor | Experimental |
| `happier copilot` | Copilot | Experimental |
| `happier grok` | Grok | Experimental |
| `happier pi` | Pi | Experimental |
| `happier devin` | Devin | Experimental |
| `happier agy` | Antigravity | Experimental |
| `happier fx` | FX | Experimental |
| `happier droid` | Factory Droid | Experimental |
| `happier codebuddy` | CodeBuddy | Experimental |

Experimental agents are enabled per-account in the app and may change without a
deprecation window. Each agent needs its own vendor CLI installed and
authenticated on the machine running the session, except Antigravity, whose ACP server
Happier installs and pins itself — the interactive `agy` CLI still has to be
installed separately for the terminal surface. Per-agent install, auth, resume,
model, mode and MCP behavior is documented at
<https://docs.happier.dev/agents>.

User-defined ACP backends are managed with `happier acp-catalog` rather than a
per-agent subcommand.

### Utility Commands

- `happier auth` – Manage authentication
- `happier connect` – Store AI vendor API keys in Happier cloud
- `happier notify` – Send a push notification to your devices
- `happier daemon` – Manage background service
- `happier doctor` – System diagnostics & troubleshooting

### Connect Subcommands

```bash
happier connect gemini     # Authenticate with Google for Gemini
happier connect claude     # Authenticate with Anthropic
happier connect codex      # Authenticate with OpenAI
happier connect status     # Show connection status for all vendors
```

### Gemini Subcommands

```bash
happier gemini                      # Start Gemini session
happier gemini model set <model>    # Set default model
happier gemini model get            # Show current model
happier gemini project set <id>     # Set Google Cloud Project ID (for Workspace accounts)
happier gemini project get          # Show current Google Cloud Project ID
```

**Suggested models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3-flash-preview`, `gemini-3-pro-preview`, `gemini-3.1-pro-preview` (freeform model ids are also supported)

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission intent: `read_only`, `default`, `auto`, or `yolo` (legacy aliases like `read-only`, `safe-yolo`, `workspace_write`, `accept-edits`, and `bypass-permissions` are accepted)
- `--permission-mode-updated-at <unix-ms>` - Optional timestamp (ms) for ordering permission changes across devices
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Session Options (agent commands)

These flags are accepted by every agent command in the table above (`codex`, `gemini`, `opencode`, `kimi`, `devin`, `agy`, `fx`, `droid`, `codebuddy` and the rest). Which of them actually take effect is capability-driven: `--agent-mode` and `--model` apply only where the provider advertises modes or models over ACP.

- `--permission-mode <mode>` - Permission intent: `read_only`, `default`, `auto`, or `yolo` (compatible aliases accepted)
- `--permission-mode-updated-at <unix-ms>` - Optional timestamp (ms) for ordering permission changes across devices
- `--agent-mode <id>` - ACP session mode id (e.g. `plan`), when supported by the provider
- `--agent-mode-updated-at <unix-ms>` - Optional timestamp (ms) for ordering ACP mode changes across devices
- `--model <id>` - Session model override (capability-driven; may be best-effort depending on provider)
- `--model-updated-at <unix-ms>` - Optional timestamp (ms) for ordering model changes across devices

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version

## Permissions

Happier uses **one permission vocabulary** across providers.

You can set permissions either:
- from the CLI when starting a session (`--permission-mode ...`), or
- from the app UI (in-session picker and Session settings).

The selected permission intent is normalized into compatible **session metadata** so it stays consistent across devices and when switching local ↔ remote.

### Common examples

```bash
# Claude (default) in Auto
happier --permission-mode auto

# Codex in Read-only (deny write-like tools)
happier codex --permission-mode read_only

# Gemini in yolo (aliases accepted)
happier gemini --permission-mode full-access

# OpenCode in plan mode (ACP session mode)
happier opencode --agent-mode plan

# Kilo in plan mode (ACP session mode)
happier kilo --agent-mode plan

# Select a model when supported
happier gemini --model gemini-2.5-pro

# Older Happier and provider-native tokens remain compatible aliases
happier --permission-mode workspace_write     # => Auto intent
happier --permission-mode accept-edits        # => Auto intent
happier --permission-mode bypass-permissions  # => YOLO intent

# Legacy: some ACP agents used to accept plan as a permission. Happier still accepts it,
# but will map it to `--agent-mode plan` (and warn) when the provider exposes ACP modes.
happier opencode --permission-mode plan        # => --agent-mode plan (deprecated)
happier kilo --permission-mode plan            # => --agent-mode plan (deprecated)
```

### What’s enforced where

Depending on the provider, a permission mode can map to:
- a provider-native “session mode” (when available), and/or
- Happier’s tool approval gating (Read-only/Auto/YOLO behavior).

Important provider constraints:
- **Codex (ACP)**: provider session modes are policy presets (approval + sandbox), not generic “plan/build” agent modes. Happier keeps permissions as the primary user control and maps to the closest preset.
- **Codex (MCP)**: approval behavior can change mid-session, but many sandbox/environment constraints are decided at session start.
- **Claude**: `read-only` is best-effort (Claude does not have a strict read-only mode); Happier will map to the closest supported behavior.
- **Pi**: Read-only uses a tool allowlist. Auto, Default, and YOLO preserve Pi's native tool catalog, including its platform shell tool and installed extension/custom tools such as subagents; they are not a workspace-confinement guarantee.
- **ACP “Mode”** (`--agent-mode`): this is separate from permissions and is provider-defined (for example OpenCode “plan” vs “build”).

Model selection behavior:
- **Claude**: applies on the next prompt.
- **Codex (MCP)**: model is start-session scoped.
- **ACP agents**: Happier prefers live `session/set_model`, with config-option fallback when available.
- **Gemini (ACP)**: model changes may recreate the underlying ACP process; Happier preserves context via replay/history.

For the full user guide (UI behavior, defaults, apply timing), see the app docs:
- [Permissions](https://github.com/happier-dev/happier/blob/main/apps/docs/content/docs/features/permissions.mdx)

## Environment Variables

### Happier Configuration

- `HAPPIER_PUBLIC_SERVER_URL` - Canonical/share server URL (used in QR/deep links; should work from your phone)
- `HAPPIER_LOCAL_SERVER_URL` - Optional local API URL optimization (only used for API calls, never embedded in links)
- `HAPPIER_SERVER_URL` - Legacy/compat server URL
  - If `HAPPIER_PUBLIC_SERVER_URL` is unset: treated as the canonical/share URL
  - If `HAPPIER_PUBLIC_SERVER_URL` is set: treated as a local API URL override
- `HAPPIER_WEBAPP_URL` - Custom web app URL (default: https://cloud.happier.dev)
- `HAPPIER_HOME_DIR` - Custom home directory for Happier data (default: ~/.happier)
- `HAPPIER_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPIER_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)
- `HAPPIER_ENCRYPTION_REQUIREMENT` - Set to `require_e2ee` to make the CLI/daemon refuse plaintext Account settings and sessions regardless of the server-advertised mode. The default is `follow_account`; invalid non-empty values stop startup.

### Gemini Configuration

- `GEMINI_MODEL` - Override default Gemini model
- `GOOGLE_CLOUD_PROJECT` - Google Cloud Project ID (required for Workspace accounts)

## Gemini Authentication

### Personal Google Account

Personal Gmail accounts work out of the box:

```bash
happier connect gemini
happier gemini
```

### Google Workspace Account

Google Workspace (organization) accounts require a Google Cloud Project:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Gemini API
3. Set the project ID:

```bash
happier gemini project set your-project-id
```

Or use environment variable:
```bash
GOOGLE_CLOUD_PROJECT=your-project-id happier gemini
```

**Guide:** https://goo.gle/gemini-cli-auth-docs#workspace-gca

## Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Requirements

- Node.js >= 20.0.0

### For Claude

- Claude CLI installed & logged in (`claude` command available in PATH)

### For Gemini

- Gemini CLI installed (`gemini` command available in PATH or installed via Happier provider settings)
- Google account authenticated via `happier connect gemini`

## License

MIT
