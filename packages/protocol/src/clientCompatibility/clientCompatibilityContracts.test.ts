import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V1,
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V3,
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V4,
  ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V5,
  ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION,
  ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION,
  CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
  EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1,
  EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3,
  PENDING_INPUT_PROTOCOL_VERSION_V1,
  SESSION_SYNC_PROTOCOL_VERSION_PUBLISHER_AUTHORITY_CHECK,
  SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
  AccountStoredContentCompatibilityDeclarationV1Schema,
  AccountStoredContentCompatibilityServerRequirementsV1Schema,
  AccountStoredContentUpgradeRequiredV1Schema,
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  buildAccountStoredContentCompatibilitySocketAuthV1,
  classifyCurrentAccountStoredContentServerCompatibility,
  classifyAccountEncryptionMigrateTransitionServerCompatibility,
  parseAccountStoredContentCompatibilityHttpHeadersV1,
  parseAccountStoredContentCompatibilitySocketAuthV1,
} from './index.js';

describe('compatibility protocol contracts', () => {
  it('owns independent session capability thresholds without a combined declaration protocol', () => {
    expect(SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY).toBe(2);
    expect(SESSION_SYNC_PROTOCOL_VERSION_PUBLISHER_AUTHORITY_CHECK).toBe(3);
    expect(PENDING_INPUT_PROTOCOL_VERSION_V1).toBe(1);
    expect(CURRENT_PENDING_INPUT_PROTOCOL_VERSION).toBe(1);
    expect(EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION_V1).toBe(1);
    expect(EXTERNAL_SESSION_RUNTIME_BOUND_ADMISSION_VERSION_V3).toBe(3);
    expect(CURRENT_EXTERNAL_SESSION_IMPORT_PUBLICATION_FENCE_VERSION).toBe(3);
  });

  it('owns the orthogonal account-stored-content declaration', () => {
    expect(ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V1).toBe(1);
    expect(ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2).toBe(2);
    expect(ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V3).toBe(3);
    expect(ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V4).toBe(4);
    expect(ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V5).toBe(5);
    expect(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION).toBe(3);
    expect(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION).toBe(3);
    expect(ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION).toBe(4);
    expect(ACCOUNT_STORED_CONTENT_ACCOUNT_ENCRYPTION_TRANSITION_PROTOCOL_VERSION)
      .toBe(5);
    expect(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION).toBe(4);
    expect(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION).toEqual({
      v: 1,
      protocolVersion: 4,
    });
    expect(buildAccountStoredContentCompatibilityHttpHeadersV1(
      CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    )).toEqual({
      'x-happier-account-stored-content-protocol': '4',
    });
    expect(PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION).toEqual({
      v: 1,
      protocolVersion: 3,
    });

    const declaration = AccountStoredContentCompatibilityDeclarationV1Schema.parse({
      v: 1,
      protocolVersion: 1,
    });
    expect(buildAccountStoredContentCompatibilityHttpHeadersV1(declaration)).toEqual({
      'x-happier-account-stored-content-protocol': '1',
    });
    expect(buildAccountStoredContentCompatibilitySocketAuthV1(declaration)).toEqual({
      accountStoredContentCompatibility: declaration,
    });
    expect(parseAccountStoredContentCompatibilityHttpHeadersV1({
      'x-happier-account-stored-content-protocol': '1',
    })).toEqual({ status: 'valid', declaration });
    expect(parseAccountStoredContentCompatibilitySocketAuthV1({
      accountStoredContentCompatibility: declaration,
    })).toEqual({ status: 'valid', declaration });
  });

  it('classifies missing and malformed account declarations as legacy', () => {
    expect(parseAccountStoredContentCompatibilityHttpHeadersV1({})).toEqual({ status: 'missing' });
    expect(parseAccountStoredContentCompatibilityHttpHeadersV1({
      'x-happier-account-stored-content-protocol': '01',
    })).toEqual({ status: 'malformed' });
    expect(parseAccountStoredContentCompatibilitySocketAuthV1({})).toEqual({ status: 'missing' });
    expect(parseAccountStoredContentCompatibilitySocketAuthV1({
      accountStoredContentCompatibility: { v: 1, protocolVersion: '1' },
    })).toEqual({ status: 'malformed' });
  });

  it('keeps account requirements and typed 426 results strict', () => {
    expect(AccountStoredContentCompatibilityServerRequirementsV1Schema.parse({
      v: 1,
      minimumProtocolVersion: 2,
      currentProtocolVersion: 3,
      declarationTransport: 'http-header-and-socket-auth-v1',
    })).toBeTruthy();
    expect(AccountStoredContentUpgradeRequiredV1Schema.parse({
      error: 'client-upgrade-required',
      requirement: {
        v: 1,
        kind: 'account-stored-content',
        minimumProtocolVersion: 2,
      },
    })).toBeTruthy();
    expect(AccountStoredContentUpgradeRequiredV1Schema.safeParse({
      error: 'client-upgrade-required',
      requirement: {
        v: 1,
        kind: 'account-stored-content',
        minimumProtocolVersion: 1,
        minimumSessionSyncProtocolVersion: 3,
      },
    }).success).toBe(false);
  });

  it('classifies account server support without feature-bit or app-version inference', () => {
    const current = {
      v: 1,
      minimumProtocolVersion: 2,
      currentProtocolVersion: 3,
      declarationTransport: 'http-header-and-socket-auth-v1',
    } as const;
    expect(classifyCurrentAccountStoredContentServerCompatibility(undefined)).toBe('missing');
    expect(classifyCurrentAccountStoredContentServerCompatibility({})).toBe('malformed');
    expect(classifyCurrentAccountStoredContentServerCompatibility(current)).toBe('compatible');
    expect(classifyCurrentAccountStoredContentServerCompatibility({
      ...current,
      currentProtocolVersion: 1,
      minimumProtocolVersion: 1,
    })).toBe('server-too-old');
    expect(classifyCurrentAccountStoredContentServerCompatibility({
      ...current,
      minimumProtocolVersion: 4,
      currentProtocolVersion: 4,
    })).toBe('client-too-old');
  });

  it('keeps V5 Account-transition support separate from the general V3 requirement', () => {
    const v3Server = {
      v: 1,
      minimumProtocolVersion: 2,
      currentProtocolVersion: 3,
      declarationTransport: 'http-header-and-socket-auth-v1',
    } as const;
    const v5TransitionServer = {
      ...v3Server,
      minimumProtocolVersion: 5,
      currentProtocolVersion: 5,
    } as const;

    expect(classifyCurrentAccountStoredContentServerCompatibility(v3Server))
      .toBe('compatible');
    expect(classifyAccountEncryptionMigrateTransitionServerCompatibility(v3Server))
      .toBe('server-too-old');
    expect(classifyAccountEncryptionMigrateTransitionServerCompatibility(
      v5TransitionServer,
    )).toBe('compatible');
  });
});
