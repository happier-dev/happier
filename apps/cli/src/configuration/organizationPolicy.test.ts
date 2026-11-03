import { describe, expect, it, vi } from 'vitest';
import { loadOrganizationPolicy, resolveOrganizationPolicyFilePath } from '@happier-dev/cli-common/organizationPolicy/readOrganizationPolicyFile';

describe('machine organization policy file', () => {
  it.each([
    ['linux', '/etc/happier/policy.json'],
    ['darwin', '/Library/Application Support/Happier/policy.json'],
    ['win32', 'D:\\Programs\\Happier\\policy.json'],
  ] as const)('uses the fixed %s path', (platform, expected) => {
    expect(resolveOrganizationPolicyFilePath(platform, () => 'D:\\Programs')).toBe(expected);
  });

  it('opens an absent policy exactly once, without stat or env selection', () => {
    const readFile = vi.fn(() => { throw Object.assign(new Error('private OS details'), { code: 'ENOENT' }); });
    expect(loadOrganizationPolicy({ platform: 'linux', readFile, resolveProgramFiles: () => '' })).toEqual({ status: 'absent' });
    expect(readFile).toHaveBeenCalledExactlyOnceWith('/etc/happier/policy.json');
  });

  it('loads through the shared parser and never projects unreadable values', () => {
    expect(loadOrganizationPolicy({ platform: 'linux', readFile: () => Buffer.from('{"schemaVersion":1,"organization":"Example"}'), resolveProgramFiles: () => '' })).toMatchObject({ status: 'loaded', policy: { organization: 'Example' } });
    const result = loadOrganizationPolicy({ platform: 'linux', readFile: () => { throw Object.assign(new Error('secret-private-path'), { code: 'EACCES' }); }, resolveProgramFiles: () => '' });
    expect(result).toEqual({ status: 'invalid', error: { path: '/etc/happier/policy.json', code: 'file_unreadable' } });
    expect(JSON.stringify(result)).not.toContain('secret-private-path');
  });

  it('fails closed when the native Windows folder cannot be resolved', () => {
    const readFile = vi.fn(() => Buffer.alloc(0));
    const result = loadOrganizationPolicy({ platform: 'win32', readFile, resolveProgramFiles: () => { throw new Error('private native failure'); } });
    expect(result).toEqual({ status: 'invalid', error: { path: '$', code: 'path_unavailable' } });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 instead of substituting policy text', () => {
    expect(loadOrganizationPolicy({ platform: 'linux', readFile: () => Buffer.from([0xff]), resolveProgramFiles: () => '' })).toEqual({ status: 'invalid', error: { path: '/etc/happier/policy.json', code: 'invalid_utf8' } });
  });
});
