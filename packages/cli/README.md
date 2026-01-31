# Happier

Code on the go — control AI coding agents from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g @happier-dev/cli
```

## Usage

### Claude (default)

```bash
happier
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

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

### Main Commands

- `happier` – Start Claude Code session (default)
- `happier gemini` – Start Gemini CLI session
- `happier codex` – Start Codex mode

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

**Available models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`

## Options

### Claude Options

- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

### Global Options

- `-h, --help` - Show help
- `-v, --version` - Show version

## Environment Variables

### Happy Configuration

- `HAPPY_SERVER_URL` - Custom server URL (default: https://api.happier.dev)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://app.happier.dev)
- `HAPPY_HOME_DIR` - Custom home directory for Happier data (default: ~/.happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

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

- Gemini CLI installed (`npm install -g @google/gemini-cli`)
- Google account authenticated via `happier connect gemini`

## License

MIT
