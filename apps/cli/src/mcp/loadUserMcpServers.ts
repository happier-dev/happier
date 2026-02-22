import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { logger } from '@/ui/logger';

/**
 * Load MCP servers from Claude's global config file.
 *
 * Reads: `~/.claude/mcp_servers.json` (or `CLAUDE_CONFIG_DIR` override).
 * Format: `{ "mcpServers": { "<name>": { "command": "...", "args": [...] } } }`
 */
export function loadClaudeMcpServers(claudeConfigDir?: string | null): Record<string, unknown> {
  const configDir = claudeConfigDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const filePath = join(configDir, 'mcp_servers.json');
  return loadMcpFromJsonFile(filePath, 'claude');
}

/**
 * Load MCP servers from Codex's global config file.
 *
 * Reads: `~/.codex/config.toml` (or `CODEX_HOME` override).
 * Parses `[mcp_servers.<name>]` sections with `command` and `args` fields.
 */
export function loadCodexMcpServers(): Record<string, unknown> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const filePath = join(codexHome, 'config.toml');
  return loadMcpFromToml(filePath, 'codex');
}

function loadMcpFromJsonFile(filePath: string, label: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const servers = raw?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    const count = Object.keys(servers as Record<string, unknown>).length;
    if (count > 0) {
      logger.debug(`[MCP] Loaded ${count} server(s) from ${label}: ${filePath}`);
    }
    return servers as Record<string, unknown>;
  } catch (err) {
    logger.debug(`[MCP] Failed to parse ${label} config: ${filePath}`, err);
    return {};
  }
}

/**
 * Minimal TOML parser for `[mcp_servers.*]` sections only.
 *
 * Avoids adding a TOML dependency for a single config file.
 * Only extracts `command = "..."` and `args = [ "...", ... ]` fields.
 * Handles common TOML escape sequences (`\\`, `\"`, `\n`, `\t`, `\r`).
 *
 * Limitations: does not handle multiline basic strings (`"""..."""`),
 * literal strings (`'...'`), or inline tables.
 */
function loadMcpFromToml(filePath: string, label: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, 'utf8');
    const servers: Record<string, { command: string; args?: string[] }> = {};

    // Collect all [mcp_servers.<name>] section offsets first, then slice between them.
    const sectionRe = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
    const sections: { name: string; start: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = sectionRe.exec(content)) !== null) {
      sections.push({ name: match[1], start: match.index + match[0].length });
    }

    // Find the start of the next top-level section header after a given offset.
    const nextSectionStart = (offset: number): number => {
      const idx = content.indexOf('\n[', offset);
      return idx === -1 ? content.length : idx;
    };

    for (const section of sections) {
      const block = content.slice(section.start, nextSectionStart(section.start));
      const command = parseTomlString(block, 'command');
      if (command) {
        servers[section.name] = { command, args: parseTomlStringArray(block, 'args') };
      }
    }

    const count = Object.keys(servers).length;
    if (count > 0) {
      logger.debug(`[MCP] Loaded ${count} server(s) from ${label}: ${filePath}`);
    }
    return servers;
  } catch (err) {
    logger.debug(`[MCP] Failed to parse ${label} config: ${filePath}`, err);
    return {};
  }
}

const TOML_ESCAPES: Record<string, string> = { '\\"': '"', '\\\\': '\\', '\\n': '\n', '\\t': '\t', '\\r': '\r' };

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unescapeToml(s: string): string {
  return s.replace(/\\./g, (m) => TOML_ESCAPES[m] ?? m);
}

function parseTomlString(block: string, key: string): string | null {
  const re = new RegExp(`^${escapeForRegExp(key)}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm');
  const captured = block.match(re)?.[1];
  return captured != null ? unescapeToml(captured) : null;
}

function parseTomlStringArray(block: string, key: string): string[] {
  const re = new RegExp(`^${escapeForRegExp(key)}\\s*=\\s*\\[([^\\]]*)]`, 'm');
  const match = block.match(re);
  if (!match) return [];
  return (match[1].match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? [])
    .map((s) => unescapeToml(s.trim().replace(/^"|"$/g, '')))
    .filter(Boolean);
}
