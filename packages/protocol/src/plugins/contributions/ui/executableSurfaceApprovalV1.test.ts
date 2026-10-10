import { describe, expect, it } from 'vitest';

import {
  UI_SURFACE_ISOLATION_PROFILE_VERSION_V1,
  UiSurfaceExecutableApprovalKeyV1Schema,
  buildUiSurfaceExecutableApprovalKeyStringV1,
  createUiSurfaceExecutableSecurityFingerprintV1,
  createUiSurfaceRequestedCapabilitiesDigestV1,
} from './executableSurfaceApprovalV1.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from './hostedHtmlCapabilitiesV1.js';
import { artifactHtmlBundleFromBodyV1 } from '../../../artifacts/artifactHtmlV1.js';

const source = Object.freeze(artifactHtmlBundleFromBodyV1('<p>Hello</p>'));
const capabilities = normalizeUiSurfaceCapabilityRequestV1({ hostMethods: ['context'] })!;

function fingerprint(overrides: Partial<Parameters<typeof createUiSurfaceExecutableSecurityFingerprintV1>[0]> = {}): string {
  return createUiSurfaceExecutableSecurityFingerprintV1({
    source,
    isolationProfileVersion: UI_SURFACE_ISOLATION_PROFILE_VERSION_V1,
    networkOrigins: [],
    ...overrides,
  });
}

/**
 * Approval is keyed by *what will execute and with what authority*, never by
 * the record revision, placement, widget, tab, or plugin generation that
 * govern currentness elsewhere (Lane 08.01 §8).
 */
describe('createUiSurfaceExecutableSecurityFingerprintV1', () => {
  it('covers every bundle asset and entrypoint while ignoring file insertion order', () => {
    const bundle = artifactHtmlBundleFromBodyV1('<script src="app.js"></script>');
    const script = { mime: 'application/javascript', contentBase64: 'YWxlcnQoMSk=' };
    bundle.files['app.js'] = script;
    bundle.files['second.html'] = bundle.files['index.html'];
    const own = fingerprint({ source: bundle });
    expect(fingerprint({ source: { ...bundle, files: Object.fromEntries(Object.entries(bundle.files).reverse()) } })).toBe(own);
    expect(fingerprint({ source: { ...bundle, entrypoint: 'second.html' } })).not.toBe(own);
    for (const changed of [
      { ...bundle, files: { ...bundle.files, 'app.js': { ...script, contentBase64: 'YWxlcnQoMik=' } } },
      { ...bundle, files: { ...bundle.files, 'app.js': { ...script, mime: 'text/javascript' } } },
      { ...bundle, files: { 'index.html': bundle.files['index.html'], 'second.html': bundle.files['second.html'], 'other.js': script } },
    ]) expect(fingerprint({ source: changed })).not.toBe(own);
  });
  it('is stable for identical executable bytes, isolation profile, and egress', () => {
    expect(fingerprint()).toBe(fingerprint());
  });

  it('changes when the document bytes change', () => {
    expect(fingerprint({ source: artifactHtmlBundleFromBodyV1('<p>Hello </p>') })).not.toBe(fingerprint());
  });

  it('changes when the isolation profile version changes', () => {
    expect(fingerprint({ isolationProfileVersion: UI_SURFACE_ISOLATION_PROFILE_VERSION_V1 + 1 }))
      .not.toBe(fingerprint());
  });

  it('changes when approved egress origins change and ignores their declared order', () => {
    const withEgress = fingerprint({ networkOrigins: ['https://a.example.com', 'https://b.example.com'] });
    expect(withEgress).not.toBe(fingerprint());
    expect(fingerprint({ networkOrigins: ['https://b.example.com', 'https://a.example.com'] })).toBe(withEgress);
  });

  it('cannot be forged by moving bytes across the origin/document boundary', () => {
    expect(fingerprint({ source: artifactHtmlBundleFromBodyV1('x'), networkOrigins: ['https://a.example.com'] }))
      .not.toBe(fingerprint({ source: artifactHtmlBundleFromBodyV1('xhttps://a.example.com'), networkOrigins: [] }));
  });
});

describe('createUiSurfaceRequestedCapabilitiesDigestV1', () => {
  it('is equal for semantically equal requests and differs for an added capability', () => {
    const base = normalizeUiSurfaceCapabilityRequestV1({ hostMethods: ['context', 'watchContext'] })!;
    const reordered = normalizeUiSurfaceCapabilityRequestV1({ hostMethods: ['watchContext', 'context'] })!;
    const widened = normalizeUiSurfaceCapabilityRequestV1({
      hostMethods: ['context', 'watchContext'],
      resources: [{ pluginId: 'com.acme.health', localId: 'status' }],
    })!;

    expect(createUiSurfaceRequestedCapabilitiesDigestV1(base))
      .toBe(createUiSurfaceRequestedCapabilitiesDigestV1(reordered));
    expect(createUiSurfaceRequestedCapabilitiesDigestV1(widened))
      .not.toBe(createUiSurfaceRequestedCapabilitiesDigestV1(base));
  });

  it('separates fields so an identity cannot migrate between resources and actions', () => {
    const asResource = normalizeUiSurfaceCapabilityRequestV1({
      resources: [{ pluginId: 'com.acme.health', localId: 'status' }],
    })!;
    const asAction = normalizeUiSurfaceCapabilityRequestV1({
      actions: [{ pluginId: 'com.acme.health', localId: 'status' }],
    })!;
    expect(createUiSurfaceRequestedCapabilitiesDigestV1(asResource))
      .not.toBe(createUiSurfaceRequestedCapabilitiesDigestV1(asAction));
  });
});

describe('UiSurfaceExecutableApprovalKeyV1', () => {
  const key = Object.freeze({
    serverIdentityId: 'server-1',
    accountId: 'account-1',
    approvalSubject: 'session-record:server-1/session-9/surface/item.v1/note-3',
    executableSecurityFingerprint: fingerprint(),
    requestedCapabilitiesDigest: createUiSurfaceRequestedCapabilitiesDigestV1(capabilities),
  });

  it('is strict and rejects revision, placement, widget, or generation inputs', () => {
    expect(UiSurfaceExecutableApprovalKeyV1Schema.safeParse(key).success).toBe(true);
    expect(UiSurfaceExecutableApprovalKeyV1Schema.safeParse({ ...key, recordRevision: 4 }).success).toBe(false);
    expect(UiSurfaceExecutableApprovalKeyV1Schema.safeParse({ ...key, widgetId: 'w1' }).success).toBe(false);
    expect(UiSurfaceExecutableApprovalKeyV1Schema.safeParse({ ...key, placement: 'detailsPane' }).success).toBe(false);
    expect(UiSurfaceExecutableApprovalKeyV1Schema.safeParse({ ...key, approvalSubject: '' }).success).toBe(false);
  });

  it('refuses to let identical bytes inherit approval across sources, Homes, or Accounts', () => {
    const own = buildUiSurfaceExecutableApprovalKeyStringV1(key);
    expect(buildUiSurfaceExecutableApprovalKeyStringV1(key)).toBe(own);
    expect(buildUiSurfaceExecutableApprovalKeyStringV1({ ...key, approvalSubject: 'session-record:server-1/session-9/surface/item.v1/note-4' })).not.toBe(own);
    expect(buildUiSurfaceExecutableApprovalKeyStringV1({ ...key, serverIdentityId: 'server-2' })).not.toBe(own);
    expect(buildUiSurfaceExecutableApprovalKeyStringV1({ ...key, accountId: 'account-2' })).not.toBe(own);
  });

  it('cannot be collided by shifting characters between adjacent key parts', () => {
    expect(buildUiSurfaceExecutableApprovalKeyStringV1({ ...key, serverIdentityId: 'server-1x', accountId: 'account-1' }))
      .not.toBe(buildUiSurfaceExecutableApprovalKeyStringV1({ ...key, serverIdentityId: 'server-1', accountId: 'xaccount-1' }));
  });
});
