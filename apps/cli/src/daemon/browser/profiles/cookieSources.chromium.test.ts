import {
  createCipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import {
  listBrowserCookieSources,
  readBrowserCookieSource,
  type ChromiumKeyStore,
} from './cookieSources';

const FAR_FUTURE_SECONDS = 4102444800; // 2100-01-01
const WINDOWS_EPOCH_OFFSET_SECONDS = 11644473600n;
const chromeTime = (seconds: number) =>
  (BigInt(seconds) + WINDOWS_EPOCH_OFFSET_SECONDS) * 1_000_000n;
const profileId = (directory: string) =>
  createHash('sha256').update(directory).digest('hex');

type Row = Readonly<{
  host: string;
  name: string;
  plain?: string;
  encrypted?: Buffer;
  expires?: number;
  secure?: 0 | 1;
  httpOnly?: 0 | 1;
  sameSite?: number;
  partition?: string;
}>;

function cbc(
  key: Buffer,
  prefix: 'v10' | 'v11',
  host: string,
  value: string,
): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plaintext = Buffer.concat([
    createHash('sha256').update(host).digest(),
    Buffer.from(value),
  ]);
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(plaintext),
    cipher.final(),
  ]);
}
function gcm(key: Buffer, host: string, value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.concat([
    createHash('sha256').update(host).digest(),
    Buffer.from(value),
  ]);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, body, cipher.getAuthTag()]);
}

async function writeChromium(
  root: string,
  localState: object,
  profiles: Record<string, readonly Row[]>,
) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'Local State'), JSON.stringify(localState));
  for (const [directory, rows] of Object.entries(profiles)) {
    await mkdir(join(root, directory, 'Network'), { recursive: true });
    const db = openSqliteDatabaseSync(
      join(root, directory, 'Network', 'Cookies'),
    );
    db.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '24')",
    );
    db.exec(`CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT,
      encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER,
      has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER, source_scheme INTEGER)`);
    const insert = db.prepare(
      'INSERT INTO cookies VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, 2)',
    );
    for (const row of rows) {
      const persistent = row.expires === undefined ? 0 : 1;
      insert.run(
        row.host,
        row.partition ?? '',
        row.name,
        row.plain ?? '',
        row.encrypted ?? Buffer.alloc(0),
        '/',
        row.expires === undefined ? 0n : chromeTime(row.expires),
        row.secure ?? 1,
        row.httpOnly ?? 1,
        persistent,
        persistent,
        row.sameSite ?? -1,
      );
    }
    db.close();
  }
}

const localState = (extra: object = {}) => ({
  profile: {
    info_cache: {
      Default: { name: 'Work' },
      'Profile 1': { name: 'Personal' },
    },
  },
  ...extra,
});

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'happier-chromium-source-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('Chromium-family cookie source', () => {
  it('lists Chrome-family profiles from Local State on each OS without reading cookies or keys', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      await withHome(async (home) => {
        const local = join(home, 'AppData', 'Local');
        const chrome =
          platform === 'linux'
            ? join(home, '.config', 'google-chrome')
            : platform === 'darwin'
              ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
              : join(local, 'Google', 'Chrome', 'User Data');
        const brave =
          platform === 'linux'
            ? join(home, '.config', 'BraveSoftware', 'Brave-Browser')
            : platform === 'darwin'
              ? join(
                  home,
                  'Library',
                  'Application Support',
                  'BraveSoftware',
                  'Brave-Browser',
                )
              : join(local, 'BraveSoftware', 'Brave-Browser', 'User Data');
        await writeChromium(chrome, localState(), {
          Default: [],
          'Profile 1': [],
        });
        await writeChromium(
          brave,
          { profile: { info_cache: { Default: { name: 'Person 1' } } } },
          { Default: [] },
        );
        const keyStore: ChromiumKeyStore = {
          safeStoragePassword: vi.fn(),
          unprotectWindowsKey: vi.fn(),
        };
        const listed = await listBrowserCookieSources({
          homeDirectory: home,
          platform,
          localAppDataDirectory: local,
          keyStore,
        });
        expect(listed).toEqual({
          sources: [
            {
              browser: 'chromium',
              profileId: profileId(join(chrome, 'Default')),
              label: 'Chrome · Work',
            },
            {
              browser: 'chromium',
              profileId: profileId(join(chrome, 'Profile 1')),
              label: 'Chrome · Personal',
            },
            {
              browser: 'chromium',
              profileId: profileId(join(brave, 'Default')),
              label: 'Brave · Person 1',
            },
          ],
          unsupported: [
            { browser: 'firefox', code: 'source_unavailable' },
            { browser: 'safari', code: 'source_format_unsupported' },
          ],
        });
        expect(keyStore.safeStoragePassword).not.toHaveBeenCalled();
        expect(keyStore.unprotectWindowsKey).not.toHaveBeenCalled();
      });
    }
  });

  it('decrypts macOS v10 with the Keychain Safe Storage password and preserves selected-site metadata', () =>
    withHome(async (home) => {
      const root = join(
        home,
        'Library',
        'Application Support',
        'Google',
        'Chrome',
      );
      const key = pbkdf2Sync(
        'KEYCHAIN_SENTINEL',
        'saltysalt',
        1003,
        16,
        'sha1',
      );
      await writeChromium(root, localState(), {
        Default: [
          {
            host: '.example.test',
            name: 'sid',
            encrypted: cbc(key, 'v10', '.example.test', 'COOKIE_SENTINEL'),
            expires: FAR_FUTURE_SECONDS,
            sameSite: 1,
          },
          {
            host: 'login.example.test',
            name: 'host_only',
            encrypted: cbc(key, 'v10', 'login.example.test', 'HOST_SENTINEL'),
            httpOnly: 0,
            sameSite: 2,
          },
          {
            host: '.example.test',
            name: 'old',
            encrypted: cbc(key, 'v10', '.example.test', 'EXPIRED_SENTINEL'),
            expires: 1000,
          },
          {
            host: '.example.test',
            name: 'corrupt',
            encrypted: Buffer.concat([Buffer.from('v10'), randomBytes(32)]),
            expires: FAR_FUTURE_SECONDS,
          },
          {
            host: '.example.test',
            name: 'partitioned',
            encrypted: cbc(key, 'v10', '.example.test', 'PARTITION_SENTINEL'),
            expires: FAR_FUTURE_SECONDS,
            partition: 'https://top.test',
          },
          {
            host: '.unrelated.test',
            name: 'sid',
            encrypted: cbc(key, 'v10', '.unrelated.test', 'UNRELATED_SENTINEL'),
            expires: FAR_FUTURE_SECONDS,
          },
        ],
        'Profile 1': [
          {
            host: '.example.test',
            name: 'sid',
            encrypted: cbc(
              key,
              'v10',
              '.example.test',
              'OTHER_PROFILE_SENTINEL',
            ),
            expires: FAR_FUTURE_SECONDS,
          },
        ],
      });
      const cookieFile = join(root, 'Default', 'Network', 'Cookies');
      const before = await readFile(cookieFile);
      const safeStoragePassword = vi.fn(async () => ({
        status: 'ready' as const,
        secret: 'KEYCHAIN_SENTINEL',
      }));
      const result = await readBrowserCookieSource({
        homeDirectory: home,
        platform: 'darwin',
        browser: 'chromium',
        profileId: profileId(join(root, 'Default')),
        sites: ['https://login.example.test'],
        keyStore: { safeStoragePassword, unprotectWindowsKey: vi.fn() },
      });
      expect(result).toEqual({
        status: 'ready',
        cookies: [
          {
            domain: '.example.test',
            name: 'sid',
            value: 'COOKIE_SENTINEL',
            path: '/',
            expires: FAR_FUTURE_SECONDS,
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
          },
          {
            domain: 'login.example.test',
            name: 'host_only',
            value: 'HOST_SENTINEL',
            path: '/',
            secure: true,
            httpOnly: false,
            sameSite: 'Strict',
          },
        ],
        skipped: [
          {
            domain: '.example.test',
            name: 'old',
            status: 'skipped',
            code: 'expired',
          },
          {
            domain: '.example.test',
            name: 'corrupt',
            status: 'skipped',
            code: 'source_format_unsupported',
          },
          {
            domain: '.example.test',
            name: 'partitioned',
            status: 'skipped',
            code: 'partition_unsupported',
          },
        ],
      });
      expect(safeStoragePassword).toHaveBeenCalledTimes(1);
      expect(safeStoragePassword).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'darwin', keyringName: 'Chrome' }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /UNRELATED_SENTINEL|OTHER_PROFILE_SENTINEL|EXPIRED_SENTINEL|PARTITION_SENTINEL/,
      );
      expect(await readFile(cookieFile)).toEqual(before);
    }));

  it('decrypts Linux v10 with the peanuts fallback and v11 with the secret-service key', () =>
    withHome(async (home) => {
      const root = join(home, '.config', 'chromium');
      const peanuts = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
      const keyring = pbkdf2Sync(
        'LINUX_SECRET_SENTINEL',
        'saltysalt',
        1,
        16,
        'sha1',
      );
      await writeChromium(root, localState(), {
        Default: [
          {
            host: 'example.test',
            name: 'v10',
            encrypted: cbc(peanuts, 'v10', 'example.test', 'V10_SENTINEL'),
            expires: FAR_FUTURE_SECONDS,
          },
          {
            host: 'example.test',
            name: 'v11',
            encrypted: cbc(keyring, 'v11', 'example.test', 'V11_SENTINEL'),
            expires: FAR_FUTURE_SECONDS,
            sameSite: 0,
          },
          {
            host: 'example.test',
            name: 'plain',
            plain: 'PLAIN_SENTINEL',
            expires: FAR_FUTURE_SECONDS,
          },
        ],
      });
      const safeStoragePassword = vi.fn(async () => ({
        status: 'ready' as const,
        secret: 'LINUX_SECRET_SENTINEL',
      }));
      const result = await readBrowserCookieSource({
        homeDirectory: home,
        platform: 'linux',
        browser: 'chromium',
        profileId: profileId(join(root, 'Default')),
        sites: ['https://example.test'],
        keyStore: { safeStoragePassword, unprotectWindowsKey: vi.fn() },
      });
      expect(result).toMatchObject({
        status: 'ready',
        skipped: [],
        cookies: [
          { name: 'v10', value: 'V10_SENTINEL' },
          { name: 'v11', value: 'V11_SENTINEL', sameSite: 'None' },
          { name: 'plain', value: 'PLAIN_SENTINEL' },
        ],
      });
      expect(safeStoragePassword).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'linux', keyringName: 'Chromium' }),
      );
    }));

  it('decrypts Windows v10 with the DPAPI-protected Local State key and skips app-bound v20 records', () =>
    withHome(async (home) => {
      const local = join(home, 'AppData', 'Local');
      const root = join(local, 'Microsoft', 'Edge', 'User Data');
      const key = randomBytes(32);
      const protectedBlob = Buffer.from('DPAPI_BLOB_FIXTURE');
      await writeChromium(
        root,
        localState({
          os_crypt: {
            encrypted_key: Buffer.concat([
              Buffer.from('DPAPI'),
              protectedBlob,
            ]).toString('base64'),
            app_bound_encrypted_key: Buffer.concat([
              Buffer.from('APPB'),
              randomBytes(16),
            ]).toString('base64'),
          },
        }),
        {
          Default: [
            {
              host: '.example.test',
              name: 'v10',
              encrypted: gcm(key, '.example.test', 'WINDOWS_SENTINEL'),
              expires: FAR_FUTURE_SECONDS,
            },
            {
              host: '.example.test',
              name: 'v20',
              encrypted: Buffer.concat([Buffer.from('v20'), randomBytes(60)]),
              expires: FAR_FUTURE_SECONDS,
            },
          ],
        },
      );
      const unprotectWindowsKey = vi.fn(async (blob: Uint8Array) =>
        Buffer.from(blob).equals(protectedBlob)
          ? { status: 'ready' as const, secret: key }
          : { status: 'unavailable' as const, code: 'source_locked' as const },
      );
      const result = await readBrowserCookieSource({
        homeDirectory: home,
        platform: 'win32',
        localAppDataDirectory: local,
        browser: 'chromium',
        profileId: profileId(join(root, 'Default')),
        sites: ['https://example.test'],
        keyStore: { safeStoragePassword: vi.fn(), unprotectWindowsKey },
      });
      expect(result).toEqual({
        status: 'ready',
        cookies: [
          {
            domain: '.example.test',
            name: 'v10',
            value: 'WINDOWS_SENTINEL',
            path: '/',
            expires: FAR_FUTURE_SECONDS,
            secure: true,
            httpOnly: true,
          },
        ],
        skipped: [
          {
            domain: '.example.test',
            name: 'v20',
            status: 'skipped',
            code: 'app_bound_encryption',
          },
        ],
      });
      expect(unprotectWindowsKey).toHaveBeenCalledTimes(1);
    }));

  it('never asks the OS for a key when nothing selected needs one, and settles a refused key without values', () =>
    withHome(async (home) => {
      const root = join(
        home,
        'Library',
        'Application Support',
        'Google',
        'Chrome',
      );
      const key = pbkdf2Sync('x', 'saltysalt', 1003, 16, 'sha1');
      await writeChromium(root, localState(), {
        Default: [
          {
            host: '.example.test',
            name: 'sid',
            encrypted: cbc(key, 'v10', '.example.test', 'COOKIE_SENTINEL'),
            expires: FAR_FUTURE_SECONDS,
          },
        ],
      });
      const input = {
        homeDirectory: home,
        platform: 'darwin' as const,
        browser: 'chromium' as const,
        profileId: profileId(join(root, 'Default')),
      };
      const unused = vi.fn();
      expect(
        await readBrowserCookieSource({
          ...input,
          sites: ['https://other.test'],
          keyStore: {
            safeStoragePassword: unused,
            unprotectWindowsKey: unused,
          },
        }),
      ).toEqual({ status: 'ready', cookies: [], skipped: [] });
      expect(unused).not.toHaveBeenCalled();
      expect(
        await readBrowserCookieSource({
          ...input,
          sites: ['https://example.test'],
          keyStore: {
            safeStoragePassword: async () => ({
              status: 'unavailable',
              code: 'source_locked',
            }),
            unprotectWindowsKey: unused,
          },
        }),
      ).toEqual({ status: 'unavailable', code: 'source_locked' });
      expect(
        await readBrowserCookieSource({
          ...input,
          profileId: 'unknown',
          sites: ['https://example.test'],
          keyStore: {
            safeStoragePassword: unused,
            unprotectWindowsKey: unused,
          },
        }),
      ).toEqual({ status: 'unavailable', code: 'source_unavailable' });
    }));
});
