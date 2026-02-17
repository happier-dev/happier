# Summary

Adds support for custom Claude CLI configuration variants, allowing users to switch between different Claude API configurations at invocation time. This enables using Anthropic's native API alongside alternative providers like Z.ai's GLM models (which are available through an Anthropic-compatible API).

## Background

We wanted to use Z.ai's GLM models alongside Anthropic's Claude models. So, I tried to use OpenCode as our Z.ai model provider, however OpenCode lacks interactive switchover between local and remote sessions. The Claude provider supports this, so we migrated to Claude by adding the ability to switch between different Claude configurations at invocation time (one for Anthropic's API, another for Z.ai's API).

## Changes

### Core Functionality

**Schema v6**: Added `claudeVariants` field to settings schema
- Each variant has a `configDir` (absolute path to Claude config) and optional `description`
- Automatic migration from v5 to v6 initializes empty `claudeVariants` object

**CLI Command (`apps/cli/src/backends/claude/cli/command.ts`)**:
- Syntax: `happier claude [variant-name] [claude-args...]`
- Checks if first argument is a defined variant
- Switches Claude to use the variant's config directory
- Displays confirmation when variant is matched

### Tests

**New file**: `apps/cli/src/persistence.claudeVariants.test.ts`
- Schema migration from v5 to v6
- Variant storage and retrieval
- Settings preservation during updates

## Example Configuration

Add a variant to your Happier settings (`~/.happier/settings.json`):

```json
{
  "schemaVersion": 6,
  "claudeVariants": {
    "zhipu": {
      "configDir": "/home/user/.claude-zhipu",
      "description": "Claude with Z.ai GLM-5 backend"
    },
    "minimax": {
      "configDir": "/home/user/.claude-minimax",
      "description": "Claude with MiniMax backend"
    }
  }
}
```

Then use the variant:
```bash
happier claude zhipu 'list files in current directory'
happier claude minimax 'explain this code'
```

Or for interactive mode:
```bash
happier claude zhipu
happier claude minimax
```

## Technical Details

### Why This Approach?

The variant config directory must be set before the Claude CLI process starts. By setting it at spawn time, Happier becomes the switch point between different Claude installations, each configured with their own model backends, API keys, and settings.

### Configuration Precedence

When a variant is specified, its config directory takes precedence over:
- Default `~/.claude` directory
- Any config directory set in the parent environment

## Migration

- Existing users automatically migrate to schema v6 on next `readSettings()` call
- Empty `claudeVariants` object is added (no variants defined by default)
- All existing settings are preserved

## How to verify it

1. Create a custom Claude config directory (e.g., `~/.claude-test/settings.json`)
2. Add a variant to Happier settings via CLI or manually edit `~/.happier/settings.json`:

```json
{
  "claudeVariants": {
    "test": {
      "configDir": "/home/user/.claude-test",
      "description": "Test variant"
    }
  }
}
```

3. Test variant invocation:
   ```bash
   happier claude test 'echo hello'
   ```

4. Verify the variant is recognized and config dir is set:
   - Should see: `[Happier] Using Claude variant "test" with config dir: /home/user/.claude-test`
   - Claude should use settings from `~/.claude-test/settings.json`


5. Run tests:
   ```bash
   cd apps/cli && yarn test persistence.claudeVariants.test.ts
   ```
