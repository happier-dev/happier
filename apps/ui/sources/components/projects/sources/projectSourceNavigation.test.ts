import { describe, expect, it } from 'vitest';

import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { redirectNativeSystemPath, resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';
import { buildProjectSourceSetupUrl, parseProjectSourceSetupLink, projectSourceSetupRoute } from './projectSourceNavigation';

describe('portable Source setup navigation', () => {
  it('roundtrips the Home producer carrier through web, native and classifier without carrying a key or granting access', () => {
    const homeTarget = JSON.stringify({ kind: 'descriptor', authority: 'trusted_enrollment', descriptor: {
      v: 1, homeServerIdentityId: 'srv_linked', canonicalServerUrl: 'https://home.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://home.test' }],
    } });
    const selection = { sourceId: 'source/a?x=1', homeTarget };
    const path = projectSourceSetupRoute(selection);
    const url = buildProjectSourceSetupUrl({ applicationOrigin: 'https://app.test/base/', ...selection });
    expect(parseProjectSourceSetupLink(url)).toEqual({ ...selection, path });
    expect(classifyPairingLink(url)).toEqual({ kind: 'source_setup', ...selection, path });
    expect(resolveNativeAppLinkHref(url)).toBe(path);
    expect(redirectNativeSystemPath({ path: url, initial: true })).toBe(path);
    for (const native of [`happier://${path.slice(1)}`, `happier:///${path.slice(1)}`, `happier-dev://${path.slice(1)}`]) {
      expect(resolveNativeAppLinkHref(native)).toBe(path);
      expect(redirectNativeSystemPath({ path: native, initial: true })).toBe(path);
    }
    expect([...new URL(url).searchParams.keys()]).toEqual(['source', 'target']);
    expect(parseProjectSourceSetupLink(`${url}&grant=ignored#k=ignored`)).toEqual({ ...selection, path });
  });

  it('rejects ambiguous/missing route identities, the collection creation sentinel and non-app schemes', () => {
    for (const url of [
      'https://app.test/projects/setup?source=new&target=srv_linked',
      'https://app.test/projects/setup?source=source-a',
      'https://app.test/projects/setup?target=srv_linked',
      'https://app.test/projects/setup?source=source-a&target=srv_linked&target=srv_other',
      'https://app.test/projects/setup/other?source=source-a&target=srv_linked',
      'other://projects/setup?source=source-a&target=srv_linked',
    ]) expect(parseProjectSourceSetupLink(url)).toBeNull();
    expect(resolveNativeAppLinkHref('other://projects/setup?source=source-a&target=srv_linked')).toBeNull();
    expect(() => buildProjectSourceSetupUrl({ applicationOrigin: 'https://user:secret@app.test', sourceId: 'a', homeTarget: 'srv_linked' })).toThrow();
  });
});
