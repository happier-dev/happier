import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  execFileWithDeadline,
  windowsSystemToolCommand,
} from '@happier-dev/cli-common/process';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import {
  BrowserCookieV1Schema,
  type BrowserCookieSourceResultV1,
  type BrowserCookieV1,
  type BrowserLoginImportRecordV1,
} from '@happier-dev/protocol/browser/profile/v1';

/** Value-free outcome of the OS boundary; secrets never travel inside an error. */
type KeyResult<T> =
  | { status: 'ready'; secret: T }
  | { status: 'unavailable'; code: 'source_locked' | 'source_unavailable' };

/**
 * The only OS credential boundary: the person's own Keychain/secret service
 * (macOS, Linux) and their own DPAPI user key (Windows). The OS owns consent.
 */
export type ChromiumKeyStore = Readonly<{
  safeStoragePassword(
    input: Readonly<{
      platform: 'darwin' | 'linux';
      keyringName: string;
      signal?: AbortSignal;
    }>,
  ): Promise<KeyResult<string>>;
  unprotectWindowsKey(
    blob: Uint8Array,
    signal?: AbortSignal,
  ): Promise<KeyResult<Uint8Array>>;
}>;

export type ChromiumSourceEnvironment = Readonly<{
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  localAppDataDirectory?: string;
  keyStore?: ChromiumKeyStore;
}>;

/** `keyringName` is the vendor's Safe Storage name; Linux Edge stores under Chromium's. */
const VENDORS = [
  {
    label: 'Chrome',
    keyring: 'Chrome',
    linuxKeyring: 'Chrome',
    linux: ['google-chrome'],
    darwin: ['Google', 'Chrome'],
    win32: ['Google', 'Chrome', 'User Data'],
  },
  {
    label: 'Chromium',
    keyring: 'Chromium',
    linuxKeyring: 'Chromium',
    linux: ['chromium'],
    darwin: ['Chromium'],
    win32: ['Chromium', 'User Data'],
  },
  {
    label: 'Edge',
    keyring: 'Microsoft Edge',
    linuxKeyring: 'Chromium',
    linux: ['microsoft-edge'],
    darwin: ['Microsoft Edge'],
    win32: ['Microsoft', 'Edge', 'User Data'],
  },
  {
    label: 'Brave',
    keyring: 'Brave',
    linuxKeyring: 'Brave',
    linux: ['BraveSoftware', 'Brave-Browser'],
    darwin: ['BraveSoftware', 'Brave-Browser'],
    win32: ['BraveSoftware', 'Brave-Browser', 'User Data'],
  },
] as const;
type Vendor = (typeof VENDORS)[number];

class Unavailable extends Error {
  constructor(
    readonly code:
      | 'source_locked'
      | 'source_unavailable'
      | 'source_format_unsupported',
  ) {
    super(code);
  }
}

function vendorRoot(
  vendor: Vendor,
  input: ChromiumSourceEnvironment,
): string | null {
  const home = input.homeDirectory ?? homedir();
  switch (input.platform ?? process.platform) {
    case 'linux':
      return join(home, '.config', ...vendor.linux);
    case 'darwin':
      return join(home, 'Library', 'Application Support', ...vendor.darwin);
    case 'win32':
      return join(
        input.localAppDataDirectory ??
          process.env.LOCALAPPDATA ??
          join(home, 'AppData', 'Local'),
        ...vendor.win32,
      );
    default:
      return null;
  }
}

async function readLocalState(
  root: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(root, 'Local State'), 'utf8'),
    );
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Lists profiles from each installed vendor's `Local State`; never opens cookies or keys. */
export async function chromiumProfiles(input: ChromiumSourceEnvironment) {
  const profiles = [];
  for (const vendor of VENDORS) {
    const root = vendorRoot(vendor, input);
    const state = root ? await readLocalState(root) : null;
    const cache = field(field(state, 'profile'), 'info_cache');
    if (!root || !cache || typeof cache !== 'object') continue;
    for (const [name, info] of Object.entries(cache)) {
      // Directory names come from Chrome's own state; reject anything that could leave the root.
      if (
        !name ||
        name.includes('/') ||
        name.includes('\\') ||
        name === '.' ||
        name === '..'
      )
        continue;
      const directory = join(root, name);
      const display = field(info, 'name');
      profiles.push({
        browser: 'chromium' as const,
        profileId: createHash('sha256').update(directory).digest('hex'),
        label: `${vendor.label} · ${typeof display === 'string' && display ? display : name}`,
        directory,
        root,
        vendor,
      });
    }
  }
  return profiles;
}

async function runKeyTool(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
  inputBytes?: Uint8Array,
) {
  try {
    const { stdout } = await execFileWithDeadline(command, args, {
      encoding: 'utf8',
      signal,
      inputBytes,
    });
    return { ok: true as const, stdout: String(stdout) };
  } catch (error) {
    // The error may carry tool output; keep only the exit classification.
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return { ok: false as const, code };
  }
}

/** Production boundary: OS tools through the binary-safe exec owner, argument arrays only. */
export const osChromiumKeyStore: ChromiumKeyStore = {
  async safeStoragePassword({ platform, keyringName, signal }) {
    if (platform === 'darwin') {
      const result = await runKeyTool(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-w',
          '-s',
          `${keyringName} Safe Storage`,
          '-a',
          keyringName,
        ],
        signal,
      );
      if (result.ok)
        return { status: 'ready', secret: result.stdout.replace(/\r?\n$/, '') };
      // 44: no such item. Anything else (51/128 denied, keychain locked) needs the person's unlock.
      return {
        status: 'unavailable',
        code: result.code === 44 ? 'source_unavailable' : 'source_locked',
      };
    }
    const secret = await runKeyTool(
      'secret-tool',
      ['lookup', 'application', keyringName.toLowerCase()],
      signal,
    );
    if (secret.ok && secret.stdout)
      return { status: 'ready', secret: secret.stdout.replace(/\r?\n$/, '') };
    const wallet = await runKeyTool(
      'kwallet-query',
      [
        '--read-password',
        `${keyringName} Safe Storage`,
        '--folder',
        `${keyringName} Keys`,
        'kdewallet',
      ],
      signal,
    );
    if (wallet.ok && wallet.stdout.trim())
      return { status: 'ready', secret: wallet.stdout.replace(/\r?\n$/, '') };
    return { status: 'unavailable', code: 'source_unavailable' };
  },
  async unprotectWindowsKey(blob, signal) {
    // CurrentUser DPAPI only: the same authorization Chrome itself uses for v10. Input arrives on stdin.
    const script =
      'Add-Type -AssemblyName System.Security;' +
      '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
      "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
    const result = await runKeyTool(
      windowsSystemToolCommand('powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      signal,
      Buffer.from(Buffer.from(blob).toString('base64')),
    );
    if (!result.ok) return { status: 'unavailable', code: 'source_locked' };
    const key = Buffer.from(result.stdout.trim(), 'base64');
    return key.length === 32
      ? { status: 'ready', secret: key }
      : { status: 'unavailable', code: 'source_unavailable' };
  },
};

type Decryptor = (encrypted: Buffer) => Promise<Buffer | 'app_bound' | null>;

function createDecryptor(
  profile: Awaited<ReturnType<typeof chromiumProfiles>>[number],
  input: ChromiumSourceEnvironment,
  state: Record<string, unknown> | null,
  signal?: AbortSignal,
): Decryptor {
  const platform = input.platform ?? process.platform;
  const keyStore = input.keyStore ?? osChromiumKeyStore;
  const keys = new Map<string, Promise<Buffer>>();
  // One OS acquisition per read, and only when a selected record needs it.
  const once = (id: string, acquire: () => Promise<Buffer>) => {
    let pending = keys.get(id);
    if (!pending) {
      pending = acquire();
      keys.set(id, pending);
    }
    return pending;
  };
  const unwrap = <T>(result: KeyResult<T>): T => {
    if (result.status !== 'ready') throw new Unavailable(result.code);
    return result.secret;
  };
  const cbcKey = (password: string, iterations: number) =>
    pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
  const cbc = (key: Buffer, body: Buffer) => {
    const decipher = createDecipheriv(
      'aes-128-cbc',
      key,
      Buffer.alloc(16, ' '),
    );
    return Buffer.concat([decipher.update(body), decipher.final()]);
  };
  return async (encrypted) => {
    const prefix = encrypted.subarray(0, 3).toString('latin1');
    const body = encrypted.subarray(3);
    if (platform === 'win32') {
      // Chrome 127+ app-bound encryption: only Chrome's elevated service can unwrap it. Not circumvented.
      if (prefix === 'v20') return 'app_bound';
      if (prefix !== 'v10' || body.length < 12 + 16) return null;
      const key = await once('dpapi', async () => {
        const wrapped = field(field(state, 'os_crypt'), 'encrypted_key');
        const blob =
          typeof wrapped === 'string'
            ? Buffer.from(wrapped, 'base64')
            : Buffer.alloc(0);
        if (blob.subarray(0, 5).toString('latin1') !== 'DPAPI')
          throw new Unavailable('source_format_unsupported');
        return Buffer.from(
          unwrap(await keyStore.unprotectWindowsKey(blob.subarray(5), signal)),
        );
      });
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        body.subarray(0, 12),
      );
      decipher.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([
        decipher.update(body.subarray(12, body.length - 16)),
        decipher.final(),
      ]);
    }
    if (platform === 'darwin' && prefix === 'v10') {
      const key = await once('keychain', async () =>
        cbcKey(
          unwrap(
            await keyStore.safeStoragePassword({
              platform: 'darwin',
              keyringName: profile.vendor.keyring,
              signal,
            }),
          ),
          1003,
        ),
      );
      return cbc(key, body);
    }
    if (platform === 'linux' && prefix === 'v10')
      return cbc(cbcKey('peanuts', 1), body);
    if (platform === 'linux' && prefix === 'v11') {
      const key = await once('keyring', async () =>
        cbcKey(
          unwrap(
            await keyStore.safeStoragePassword({
              platform: 'linux',
              keyringName: profile.vendor.linuxKeyring,
              signal,
            }),
          ),
          1,
        ),
      );
      return cbc(key, body);
    }
    return null;
  };
}

/** Chrome keeps the database locked while running, so the reader opens a private copy. */
async function withCookieCopy<T>(
  profileDirectory: string,
  read: (file: string) => Promise<T>,
): Promise<T> {
  const copy = await mkdtemp(join(tmpdir(), 'happier-chromium-cookies-'));
  try {
    let source = join(profileDirectory, 'Network', 'Cookies');
    try {
      await copyFile(source, join(copy, 'Cookies'));
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
      source = join(profileDirectory, 'Cookies');
      await copyFile(source, join(copy, 'Cookies'));
    }
    try {
      await copyFile(`${source}-wal`, join(copy, 'Cookies-wal'));
    } catch {
      /* No pending WAL. */
    }
    return await read(join(copy, 'Cookies'));
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

export async function readChromiumCookieSource(
  input: ChromiumSourceEnvironment &
    Readonly<{
      profileId: string;
      domains: ReadonlySet<string>;
      signal?: AbortSignal;
    }>,
): Promise<BrowserCookieSourceResultV1> {
  const profile = (await chromiumProfiles(input)).find(
    (candidate) => candidate.profileId === input.profileId,
  );
  if (!profile) return { status: 'unavailable', code: 'source_unavailable' };
  if (input.domains.size === 0)
    return { status: 'ready', cookies: [], skipped: [] };
  input.signal?.throwIfAborted();
  const decrypt = createDecryptor(
    profile,
    input,
    await readLocalState(profile.root),
    input.signal,
  );
  try {
    return await withCookieCopy(profile.directory, async (file) => {
      const database = openSqliteDatabaseSync(file);
      try {
        const meta = database
          .prepare("SELECT value FROM meta WHERE key = 'version'")
          .get() as { value?: unknown } | undefined;
        const version = Number(meta?.value);
        const columns = new Set(
          (
            database.prepare('PRAGMA table_info(cookies)').all() as {
              name?: unknown;
            }[]
          ).map((column) => column.name),
        );
        if (
          !Number.isInteger(version) ||
          version < 10 ||
          ![
            'host_key',
            'name',
            'value',
            'encrypted_value',
            'path',
            'expires_utc',
            'is_secure',
            'is_httponly',
            'has_expires',
            'samesite',
          ].every((column) => columns.has(column))
        ) {
          return { status: 'unavailable', code: 'source_format_unsupported' };
        }
        const partition = columns.has('top_frame_site_key')
          ? 'top_frame_site_key'
          : "'' AS top_frame_site_key";
        // expires_utc is microseconds since 1601 and exceeds JS safe integers; SQLite converts to Unix seconds.
        const rows = database
          .prepare(`SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly, samesite,
          has_expires, ${partition}, expires_utc / 1000000 - 11644473600 AS expires
          FROM cookies WHERE host_key IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify([...input.domains]));
        const cookies: BrowserCookieV1[] = [];
        const skipped: BrowserLoginImportRecordV1[] = [];
        for (const value of rows) {
          input.signal?.throwIfAborted();
          const row = value as Record<string, unknown>;
          const metadata = {
            domain: typeof row.host_key === 'string' ? row.host_key : '',
            name: typeof row.name === 'string' ? row.name : '',
          };
          if (
            row.top_frame_site_key !== '' &&
            row.top_frame_site_key !== null
          ) {
            skipped.push({
              ...metadata,
              status: 'skipped',
              code: 'partition_unsupported',
            });
            continue;
          }
          const persistent = row.has_expires === 1;
          const expires =
            typeof row.expires === 'number' ? row.expires : undefined;
          if (
            persistent &&
            (expires === undefined || expires <= Date.now() / 1000)
          ) {
            skipped.push({ ...metadata, status: 'skipped', code: 'expired' });
            continue;
          }
          let plaintext: string | null =
            typeof row.value === 'string' && row.value ? row.value : null;
          const encrypted =
            row.encrypted_value instanceof Uint8Array
              ? Buffer.from(row.encrypted_value)
              : Buffer.alloc(0);
          if (plaintext === null && encrypted.length > 0) {
            let decrypted: Awaited<ReturnType<Decryptor>>;
            try {
              decrypted = await decrypt(encrypted);
            } catch (error) {
              if (error instanceof Unavailable) throw error;
              decrypted = null; // Wrong key, corrupt record or authentication failure.
            }
            if (decrypted === 'app_bound') {
              skipped.push({
                ...metadata,
                status: 'skipped',
                code: 'app_bound_encryption',
              });
              continue;
            }
            // Schema 24+ prefixes the plaintext with SHA-256(host_key); it also proves the key was right.
            if (decrypted && version >= 24) {
              const hostHash = createHash('sha256')
                .update(metadata.domain)
                .digest();
              decrypted =
                decrypted.length >= 32 &&
                decrypted.subarray(0, 32).equals(hostHash)
                  ? decrypted.subarray(32)
                  : null;
            }
            plaintext = decrypted ? decrypted.toString('utf8') : null;
          }
          const sameSite =
            row.samesite === 0
              ? 'None'
              : row.samesite === 1
                ? 'Lax'
                : row.samesite === 2
                  ? 'Strict'
                  : undefined;
          const cookie =
            plaintext === null ||
            (!sameSite && row.samesite !== -1) ||
            (row.is_secure !== 0 && row.is_secure !== 1) ||
            (row.is_httponly !== 0 && row.is_httponly !== 1)
              ? undefined
              : BrowserCookieV1Schema.safeParse({
                  ...metadata,
                  value: plaintext,
                  path: row.path,
                  secure: row.is_secure === 1,
                  httpOnly: row.is_httponly === 1,
                  ...(persistent ? { expires } : {}),
                  ...(sameSite ? { sameSite } : {}),
                });
          if (!cookie?.success) {
            skipped.push({
              ...metadata,
              status: 'skipped',
              code: 'source_format_unsupported',
            });
            continue;
          }
          cookies.push(cookie.data);
        }
        return { status: 'ready', cookies, skipped };
      } finally {
        try {
          database.close();
        } catch {
          /* The copy is discarded either way. */
        }
      }
    });
  } catch (error) {
    if (error instanceof Unavailable)
      return { status: 'unavailable', code: error.code };
    throw error;
  }
}
