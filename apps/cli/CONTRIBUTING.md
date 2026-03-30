# Contributing to Happier CLI

## Prerequisites

- Node.js >= 20.0.0
- Yarn (`npm install -g yarn`)
- Git
- Claude CLI installed and logged in (`claude` command available in PATH)

## Getting Started

```bash
git clone https://github.com/happier-dev/happier.git
cd apps/cli
yarn install
yarn build
```

## Development Commands

### Global `happier-dev` Command

Create a global `happier-dev` command that runs your local development build:

```bash
yarn link:dev      # Create happier-dev symlink
yarn unlink:dev    # Remove happier-dev symlink
```

This creates a `happier-dev` command in your PATH pointing to your local build, while leaving any npm-installed `happier` command untouched.

| Command | Runs |
|---------|------|
| `happier` | Stable npm version (from `npm install -g @happier-dev/cli`) |
| `happy` | Stable npm version (legacy alias) |
| `happier-dev` | Local development version (from this repo) |
| `happy-dev` | Local development version (legacy alias) |

**Note:** Run `yarn build` before `yarn link:dev` to ensure the binary exists.

### Build Commands

```bash
yarn build         # Build the project
yarn typecheck     # TypeScript type checking
yarn test          # Run tests
yarn dev           # Run without building (uses tsx)
```

## Stable vs Dev Data Isolation

The CLI supports running stable and development versions side-by-side with completely isolated data.

### Initial Setup (Once)

```bash
npm run setup:dev
```

This creates:
- `~/.happy/` - Stable version data (production-ready)
- `~/.happy-dev/` - Development version data (for testing changes)

### Daily Usage

**Stable (production-ready):**
```bash
npm run stable:daemon:start
```

**Development (testing changes):**
```bash
npm run dev:daemon:start
```

## Visual Indicators

You'll always see which version you're using:
- `✅ STABLE MODE - Data: ~/.happy`
- `🔧 DEV MODE - Data: ~/.happy-dev`

## Common Tasks

### Authentication

```bash
# Authenticate stable version
npm run stable auth login

# Authenticate dev version (can use same or different account)
npm run dev auth login

# Logout
npm run stable auth logout
npm run dev auth logout
```

### Daemon Management

```bash
# Check status of both
npm run stable:daemon:status
npm run dev:daemon:status

# Stop both
npm run stable:daemon:stop
npm run dev:daemon:stop

# Start both simultaneously
npm run stable:daemon:start && npm run dev:daemon:start
```

### Running Any Command

```bash
# Stable version
npm run stable <command> [args...]
npm run stable notify "Test message"
npm run stable doctor

# Dev version
npm run dev:variant <command> [args...]
npm run dev:variant notify "Test message"
npm run dev:variant doctor
```

## Data Isolation

Both versions maintain complete separation:

| Aspect | Stable | Development |
|--------|--------|-------------|
| Data Directory | `~/.happy/` | `~/.happy-dev/` |
| Settings | `~/.happy/settings.json` | `~/.happy-dev/settings.json` |
| Auth Keys | `~/.happy/access.key` | `~/.happy-dev/access.key` |
| Daemon State | `~/.happy/daemon.state.json` | `~/.happy-dev/daemon.state.json` |
| Logs | `~/.happy/logs/` | `~/.happy-dev/logs/` |

**No conflicts!** Both can run simultaneously with separate:
- Authentication sessions
- Server connections
- Daemon processes
- Session histories
- Configuration settings

## Advanced: direnv Auto-Switching

For automatic environment switching when entering directories:

1. Install [direnv](https://direnv.net/):
   ```bash
   # macOS
   brew install direnv

   # Add to your shell (bash/zsh)
   eval "$(direnv hook bash)"  # or zsh
   ```

2. Setup direnv for this project:
   ```bash
   cp .envrc.example .envrc
   direnv allow
   ```

3. Now `cd` into the directory automatically sets `HAPPIER_VARIANT=dev`!

## Troubleshooting

### Commands not working?
```bash
npm install
```

### Permission denied on scripts?
```bash
chmod +x scripts/*.cjs
```

### Data directories not created?
```bash
npm run setup:dev
```

### Both daemons won't start?
Check port conflicts - each daemon needs its own port. The dev daemon will automatically use a different port from stable.

### How do I check which version is running?
Look for the visual indicator:
- `✅ STABLE MODE` = stable version
- `🔧 DEV MODE` = development version

Or check the daemon status:
```bash
npm run stable:daemon:status   # Shows ~/.happy/ data location
npm run dev:daemon:status       # Shows ~/.happy-dev/ data location
```

### `yarn link:dev` fails with permission denied?
```bash
sudo yarn link:dev
```

### `happier-dev` command not found after linking?
- Ensure your global npm bin is in PATH: `npm bin -g`
- Try opening a new terminal window
- Check the symlink was created: `ls -la $(npm bin -g)/happier-dev`

## Tips

1. **Use stable for production work** - Your tested, reliable version
2. **Use dev for testing changes** - Test new features without breaking your workflow
3. **Run both simultaneously** - Compare behavior side-by-side
4. **Different accounts** - Use different Happier accounts for dev/stable if needed
5. **Check logs** - Logs are separated: `~/.happy/logs/` vs `~/.happy-dev/logs/`

## Example Workflow

```bash
# Initial setup (once)
yarn install
yarn build
yarn link:dev
npm run setup:dev

# Authenticate both
npm run stable auth login
npm run dev:variant auth login

# Start both daemons
npm run stable:daemon:start
npm run dev:daemon:start

# Do your development work...
# Edit code, build, test with dev version

# When ready, update stable version
npm run stable:daemon:stop
git pull  # or your deployment process
npm run stable:daemon:start

# Dev continues running unaffected!
```

## How It Works

The system uses the built-in `HAPPIER_HOME_DIR` environment variable to separate data:

- **Stable scripts** set: `HAPPIER_HOME_DIR=~/.happier`
- **Dev scripts** set: `HAPPIER_HOME_DIR=~/.happier-dev`

Everything else (auth, sessions, logs, daemon) automatically follows the `HAPPIER_HOME_DIR` setting.

Cross-platform via Node.js - works identically on Windows, macOS, and Linux!

## Testing Profile Sync Between GUI and CLI

Profile synchronization ensures AI backend configurations created in the Happier mobile/web GUI work seamlessly with the CLI daemon.

### Profile Schema Validation (Single Source of Truth)

Backend profile schema + built-in catalog are canonicalized in `@happier-dev/protocol`:
- `packages/protocol/src/profiles/backendProfileSchema.ts`
- `packages/protocol/src/profiles/builtInBackendProfiles.ts`
- `packages/protocol/src/profiles/profileCompatibility.ts`
- `packages/protocol/src/profiles/profileRequirements.ts`
- `packages/protocol/src/profiles/resolveBackendProfile.ts`

The UI and CLI import these helpers (the UI may re-export them for convenience). Avoid re-defining schemas in app code to prevent drift.

### Testing Profile Sync

1. **Create profile in GUI:**
   ```
   - Open Happier mobile/web app
   - Settings → AI Backend Profiles
   - Create new profile with custom environment variables
   - Note the profile ID
   ```

2. **Verify CLI receives profile:**
   ```bash
   # List profiles (built-ins always present; custom requires auth)
   happier profiles list
   happier profiles list --json

   # Force-refresh settings before listing (useful during iterative development)
   happier profiles list --refresh-settings
   ```

3. **Test profile-based session spawning:**
   ```bash
   # Start sessions explicitly with a profile:
   happier --profile <id-or-name>
   happier claude --profile <id-or-name>
   happier codex --profile <id-or-name>
   ```

4. **Verify environment variable expansion:**
   ```bash
   # Profiles may use ${VAR} references:
   # - if VAR is provided via the profile env overlay (UI/CLI injection), expansion must still work
   # - if VAR is not provided anywhere, the daemon will fail closed for auth-related vars
   ```

### Testing Schema Compatibility

When modifying profile schemas:

1. **Update protocol** - Make schema changes only in `packages/protocol/src/profiles/*`
2. **Run tests** - Protocol + UI + CLI unit tests should remain green
3. **Test migration** - Existing profiles should migrate gracefully
4. **Test validation** - Invalid profiles should be caught with clear errors

### Common Issues

**"Invalid profile" warnings in logs:**
- Check profile has valid UUID (not timestamp)
- Verify environment variable names match regex: `^[A-Z_][A-Z0-9_]*$`
- Ensure compatibility.claude or compatibility.codex is true

**Environment variables not expanding:**
- Verify no typos in `${VAR}` references
- For CLI-started sessions, use `--profile` and ensure required secrets/config are satisfied (env, saved secret binding, or interactive prompt)
- For GUI-started sessions, ensure required secrets are satisfied and injected via the profile overlay

## Publishing to npm

Maintainers can publish new versions:

```bash
yarn release       # Interactive version bump, changelog, publish
```

This runs tests, builds, and publishes to npm. The published package includes:
- `happy` - Main CLI command
- `happy-mcp` - MCP bridge command

**Note:** `happier-dev` is intentionally excluded from the npm package - it's for local development only.
