export type NodeRuntimeReleaseAsset = Readonly<{
  name: string;
  url: string;
  digest: string | null;
  tag: string;
  version: string;
  binaryRelativePath: string;
}>;

type NodeReleaseIndexEntry = Readonly<{
  version?: unknown;
  lts?: unknown;
}>;

const NODE_RELEASE_INDEX_URL = 'https://nodejs.org/download/release/index.json';
const NODE_RELEASE_BASE_URL = 'https://nodejs.org/download/release';

function normalizeNodeTag(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  const match = /^v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(value);
  if (!match) return null;
  return `v${match[1]}`;
}

function parseNodeVersion(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

function resolveRequestedNodeTag(processEnv: NodeJS.ProcessEnv): string | null {
  return normalizeNodeTag(processEnv.HAPPIER_MANAGED_NODE_VERSION);
}

function resolvePreferredNodeAssetNames(params: Readonly<{ tag: string; platform?: NodeJS.Platform; arch?: string }>): ReadonlyArray<string> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  if (platform === 'darwin' && arch === 'arm64') return [`node-${params.tag}-darwin-arm64.tar.gz`, `node-${params.tag}-darwin-arm64.tar.xz`];
  if (platform === 'darwin' && arch === 'x64') return [`node-${params.tag}-darwin-x64.tar.gz`, `node-${params.tag}-darwin-x64.tar.xz`];
  if (platform === 'linux' && arch === 'arm64') return [`node-${params.tag}-linux-arm64.tar.xz`, `node-${params.tag}-linux-arm64.tar.gz`];
  if (platform === 'linux' && arch === 'x64') return [`node-${params.tag}-linux-x64.tar.xz`, `node-${params.tag}-linux-x64.tar.gz`];
  if (platform === 'win32' && arch === 'arm64') return [`node-${params.tag}-win-arm64.zip`];
  if (platform === 'win32' && arch === 'x64') return [`node-${params.tag}-win-x64.zip`];
  throw new Error(`Unsupported Node runtime platform: ${platform}/${arch}`);
}

function resolveNodeBinaryRelativePath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'node.exe' : 'bin/node';
}

function selectNodeReleaseTag(index: ReadonlyArray<NodeReleaseIndexEntry>, requestedTag: string | null): string {
  if (requestedTag) {
    const exact = index.find((entry) => normalizeNodeTag(entry.version) === requestedTag);
    if (!exact) {
      throw new Error(`Managed Node version ${requestedTag} was not found in the official release index`);
    }
    return requestedTag;
  }

  const latestLts = index.find((entry) => normalizeNodeTag(entry.version) && entry.lts);
  const fallback = index.find((entry) => normalizeNodeTag(entry.version));
  const selectedTag = normalizeNodeTag(latestLts?.version) ?? normalizeNodeTag(fallback?.version);
  if (!selectedTag) {
    throw new Error('Unable to resolve a managed Node release from the official release index');
  }
  return selectedTag;
}

function parseNodeShaSums(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    if (!match) continue;
    entries.set(match[2]!.trim(), match[1]!.trim().toLowerCase());
  }
  return entries;
}

export async function fetchNodeRuntimeReleaseAsset(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}> = {}): Promise<NodeRuntimeReleaseAsset> {
  const processEnv = params.processEnv ?? process.env;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Managed Node bootstrap requires fetch support');
  }

  const indexResponse = await fetchImpl(NODE_RELEASE_INDEX_URL, {
    headers: {
      'user-agent': 'happier-cli',
      accept: 'application/json',
    },
  });
  if (!indexResponse.ok) {
    throw new Error(`Failed to fetch Node release index (${indexResponse.status})`);
  }
  const index = (await indexResponse.json()) as ReadonlyArray<NodeReleaseIndexEntry>;
  const tag = selectNodeReleaseTag(Array.isArray(index) ? index : [], resolveRequestedNodeTag(processEnv));
  const assetNames = resolvePreferredNodeAssetNames({ tag });

  const shasumsResponse = await fetchImpl(`${NODE_RELEASE_BASE_URL}/${tag}/SHASUMS256.txt`, {
    headers: {
      'user-agent': 'happier-cli',
      accept: 'text/plain',
    },
  });
  if (!shasumsResponse.ok) {
    throw new Error(`Failed to fetch Node release checksums (${shasumsResponse.status})`);
  }
  const shasums = parseNodeShaSums(await shasumsResponse.text());
  const selectedAssetName = assetNames.find((assetName) => shasums.has(assetName)) ?? null;
  if (!selectedAssetName) {
    throw new Error(`Failed to resolve checksum for Node assets ${assetNames.join(', ')}`);
  }
  const digest = shasums.get(selectedAssetName) ?? null;

  return {
    name: selectedAssetName,
    url: `${NODE_RELEASE_BASE_URL}/${tag}/${selectedAssetName}`,
    digest,
    tag,
    version: parseNodeVersion(tag),
    binaryRelativePath: resolveNodeBinaryRelativePath(),
  };
}
