import { createHash } from 'node:crypto';
import { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export type DiscoveredSshHostSource = 'ssh-config' | 'known-hosts';

export type DiscoveredSshHost = Readonly<{
  id: string;
  alias: string;
  hostname: string;
  port: number | null;
  username: string | null;
  source: DiscoveredSshHostSource;
  sourcePath: string | null;
}>;

export type DiscoverConfiguredSshHostsFs = Readonly<{
  readFile: (path: string, encoding: BufferEncoding) => Promise<string> | string;
  readdir?: (
    path: string,
    options: Readonly<{ withFileTypes: true }>,
  ) => Promise<readonly Dirent[]> | readonly Dirent[];
}>;

export type DiscoverConfiguredSshHostsOptions = Readonly<{
  homeDir?: string;
  sshConfigPath?: string;
  knownHostsPath?: string;
  maxIncludeDepth?: number;
  fs?: DiscoverConfiguredSshHostsFs;
}>;

export async function discoverConfiguredSshHosts(
  options: DiscoverConfiguredSshHostsOptions = {},
): Promise<readonly DiscoveredSshHost[]> {
  const homeDir = resolve(options.homeDir ?? homedir());
  const fs = options.fs ?? nodeFs;
  const sshConfigPath = resolveTildePath(options.sshConfigPath ?? '~/.ssh/config', homeDir, homeDir);
  const knownHostsPath = resolveTildePath(options.knownHostsPath ?? '~/.ssh/known_hosts', homeDir, homeDir);
  const maxIncludeDepth = normalizeMaxIncludeDepth(options.maxIncludeDepth);
  const configHosts = await discoverConfigHosts({
    path: sshConfigPath,
    homeDir,
    fs,
    maxIncludeDepth,
    visitedPaths: new Set(),
    depth: 0,
  });
  const knownHosts = await discoverKnownHosts({ path: knownHostsPath, fs });
  return sortAndCollapseHosts([...configHosts, ...knownHosts]);
}

const nodeFs: DiscoverConfiguredSshHostsFs = {
  readFile: async (path, encoding) => await readFile(path, encoding),
  readdir: async (path, options) => await readdir(path, options),
};

type ConfigParseState = {
  aliases: string[];
  hostname: string | null;
  username: string | null;
  port: number | null;
};

async function discoverConfigHosts(params: Readonly<{
  path: string;
  homeDir: string;
  fs: DiscoverConfiguredSshHostsFs;
  maxIncludeDepth: number;
  visitedPaths: Set<string>;
  depth: number;
}>): Promise<DiscoveredSshHost[]> {
  const path = resolve(params.path);
  if (params.visitedPaths.has(path) || params.depth > params.maxIncludeDepth) {
    return [];
  }
  params.visitedPaths.add(path);

  const text = await readTextIfPresent(params.fs, path);
  if (text === null) {
    return [];
  }

  const result: DiscoveredSshHost[] = [];
  let state: ConfigParseState | null = null;
  const flushState = () => {
    if (!state) return;
    for (const alias of state.aliases) {
      const hostname = state.hostname ?? alias;
      result.push(buildHost({
        source: 'ssh-config',
        alias,
        hostname,
        port: state.port,
        username: state.username,
        sourcePath: path,
      }));
    }
  };

  for (const rawLine of text.split(/\r?\n/u)) {
    const directive = parseSshConfigDirective(rawLine);
    if (!directive) continue;

    const key = directive.key.toLowerCase();
    if (key === 'include') {
      const includePaths = await expandIncludePatterns({
        patterns: directive.values,
        baseDir: dirname(path),
        homeDir: params.homeDir,
        fs: params.fs,
      });
      for (const includePath of includePaths) {
        result.push(...await discoverConfigHosts({
          path: includePath,
          homeDir: params.homeDir,
          fs: params.fs,
          maxIncludeDepth: params.maxIncludeDepth,
          visitedPaths: params.visitedPaths,
          depth: params.depth + 1,
        }));
      }
      continue;
    }

    if (key === 'host') {
      flushState();
      state = {
        aliases: directive.values.filter(isConcreteHostPattern),
        hostname: null,
        username: null,
        port: null,
      };
      continue;
    }

    if (!state || state.aliases.length === 0) continue;
    const value = directive.values[0]?.trim() ?? '';
    if (!value) continue;

    if (key === 'hostname' && state.hostname === null) {
      state.hostname = value;
    } else if (key === 'user' && state.username === null) {
      state.username = value;
    } else if (key === 'port' && state.port === null) {
      state.port = parsePort(value);
    }
  }

  flushState();
  return result;
}

async function discoverKnownHosts(params: Readonly<{
  path: string;
  fs: DiscoverConfiguredSshHostsFs;
}>): Promise<DiscoveredSshHost[]> {
  const text = await readTextIfPresent(params.fs, params.path);
  if (text === null) {
    return [];
  }

  const result: DiscoveredSshHost[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [hostList] = line.split(/\s+/u);
    if (!hostList) continue;

    for (const hostToken of hostList.split(',')) {
      const parsed = parseKnownHostToken(hostToken.trim());
      if (!parsed) continue;
      result.push(buildHost({
        source: 'known-hosts',
        alias: parsed.hostname,
        hostname: parsed.hostname,
        port: parsed.port,
        username: null,
        sourcePath: params.path,
      }));
    }
  }
  return result;
}

function parseSshConfigDirective(rawLine: string): Readonly<{ key: string; values: readonly string[] }> | null {
  const line = stripInlineComment(rawLine).trim();
  if (!line) return null;
  const tokens = tokenizeSshConfigLine(line);
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  if (!first) return null;

  const equalsIndex = first.indexOf('=');
  if (equalsIndex > 0) {
    const key = first.slice(0, equalsIndex).trim();
    const firstValue = first.slice(equalsIndex + 1).trim();
    const values = [firstValue, ...rest].filter((value) => value.length > 0);
    return key ? { key, values } : null;
  }

  return {
    key: first,
    values: rest,
  };
}

function stripInlineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' || char === "'") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/u.test(line[index - 1] ?? ''))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function tokenizeSshConfigLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/u.test(char ?? '')) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

async function expandIncludePatterns(params: Readonly<{
  patterns: readonly string[];
  baseDir: string;
  homeDir: string;
  fs: DiscoverConfiguredSshHostsFs;
}>): Promise<string[]> {
  const paths = new Set<string>();
  for (const pattern of params.patterns) {
    const expanded = resolveTildePath(pattern, params.homeDir, params.baseDir);
    if (hasGlobMeta(expanded)) {
      for (const path of await expandGlobPath(expanded, params.fs)) {
        paths.add(path);
      }
    } else {
      paths.add(resolve(expanded));
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function expandGlobPath(pattern: string, fs: DiscoverConfiguredSshHostsFs): Promise<string[]> {
  const normalized = resolve(pattern);
  const parsed = parse(normalized);
  const segments = normalized.slice(parsed.root.length).split(sep).filter(Boolean);
  let candidates = [parsed.root || sep];

  for (const segment of segments) {
    const next: string[] = [];
    for (const candidate of candidates) {
      if (!hasGlobMeta(segment)) {
        next.push(join(candidate, segment));
        continue;
      }
      const entries = await readDirIfPresent(fs, candidate);
      for (const entry of entries) {
        if (matchesGlobSegment(entry.name, segment)) {
          next.push(join(candidate, entry.name));
        }
      }
    }
    candidates = next;
  }

  return candidates.map((candidate) => resolve(candidate)).sort((left, right) => left.localeCompare(right));
}

function matchesGlobSegment(value: string, pattern: string): boolean {
  const expression = new RegExp(`^${[...pattern].map((char) => {
    if (char === '*') return '.*';
    if (char === '?') return '.';
    return escapeRegExp(char);
  }).join('')}$`, 'u');
  return expression.test(value);
}

function parseKnownHostToken(token: string): Readonly<{ hostname: string; port: number | null }> | null {
  if (!token || token.startsWith('|') || !isConcreteHostPattern(token)) {
    return null;
  }

  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(token);
  if (bracketed) {
    const hostname = bracketed[1]?.trim() ?? '';
    const port = parsePort(bracketed[2] ?? '');
    return hostname && port !== null ? { hostname, port } : null;
  }

  const colonCount = [...token].filter((char) => char === ':').length;
  if (colonCount === 1) {
    const [hostname, rawPort] = token.split(':');
    const port = parsePort(rawPort ?? '');
    if (hostname && port !== null) {
      return { hostname, port };
    }
  }

  return { hostname: token, port: null };
}

function sortAndCollapseHosts(hosts: readonly DiscoveredSshHost[]): readonly DiscoveredSshHost[] {
  const byTarget = new Map<string, DiscoveredSshHost>();
  const configTargets = new Set<string>();
  for (const host of hosts) {
    if (host.source === 'known-hosts' && configTargets.has(buildHostPortKey(host))) {
      continue;
    }

    const key = buildTargetKey(host);
    const existing = byTarget.get(key);
    if (!existing || (existing.source === 'known-hosts' && host.source === 'ssh-config')) {
      byTarget.set(key, host);
    }
    if (host.source === 'ssh-config') {
      configTargets.add(buildHostPortKey(host));
    }
  }

  return [...byTarget.values()].sort((left, right) => {
    const sourceOrder = sourceSortOrder(left.source) - sourceSortOrder(right.source);
    if (sourceOrder !== 0) return sourceOrder;
    const aliasOrder = left.alias.localeCompare(right.alias, undefined, { sensitivity: 'base' });
    if (aliasOrder !== 0) return aliasOrder;
    return left.hostname.localeCompare(right.hostname, undefined, { sensitivity: 'base' });
  });
}

function buildHost(params: Readonly<{
  source: DiscoveredSshHostSource;
  alias: string;
  hostname: string;
  port: number | null;
  username: string | null;
  sourcePath: string | null;
}>): DiscoveredSshHost {
  const idInput = JSON.stringify({
    source: params.source,
    alias: params.alias,
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    sourcePath: params.sourcePath,
  });
  const digest = createHash('sha256').update(idInput).digest('hex').slice(0, 24);
  return {
    id: `ssh:${digest}`,
    alias: params.alias,
    hostname: params.hostname,
    port: params.port,
    username: params.username,
    source: params.source,
    sourcePath: params.sourcePath,
  };
}

function buildTargetKey(host: DiscoveredSshHost): string {
  return [
    host.source === 'ssh-config' ? host.alias.toLowerCase() : '',
    host.hostname.toLowerCase(),
    String(host.port ?? ''),
    host.username?.toLowerCase() ?? '',
  ].join('\0');
}

function buildHostPortKey(host: DiscoveredSshHost): string {
  return [
    host.hostname.toLowerCase(),
    String(host.port ?? ''),
  ].join('\0');
}

function sourceSortOrder(source: DiscoveredSshHostSource): number {
  return source === 'ssh-config' ? 0 : 1;
}

function isConcreteHostPattern(value: string): boolean {
  return value.length > 0 && !value.includes('*') && !value.includes('?') && !value.includes('!') && !value.includes(',');
}

function hasGlobMeta(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

function parsePort(value: string): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function normalizeMaxIncludeDepth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return 8;
  }
  return Math.min(value, 32);
}

function resolveTildePath(path: string, homeDir: string, baseDir: string): string {
  const expanded = path === '~'
    ? homeDir
    : path.startsWith('~/')
      ? join(homeDir, path.slice(2))
      : path;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

async function readTextIfPresent(fs: DiscoverConfiguredSshHostsFs, path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readDirIfPresent(fs: DiscoverConfiguredSshHostsFs, path: string): Promise<readonly Dirent[]> {
  if (!fs.readdir) return [];
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}
