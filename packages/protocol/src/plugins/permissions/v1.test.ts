import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

const retiredPermissionDeclarationNames = [
  ['PLUGIN_', 'DECLARED_CAPABILITIES_V1'].join(''),
  ['PLUGIN_', 'EXPERIMENTAL_UNIMPLEMENTED_CAPABILITIES_V1'].join(''),
  ['PLUGIN_', 'DE_SCOPED_CAPABILITIES_V1'].join(''),
  ['Plugin', 'DeclaredCapabilityV1Schema'].join(''),
  ['Plugin', 'CapabilityDeclarationV1Schema'].join(''),
  ['Plugin', 'PermissionDeclarationV1Schema'].join(''),
  ['Plugin', 'DeclaredCapabilityV1'].join(''),
  ['Plugin', 'CapabilityDeclarationV1'].join(''),
  ['Plugin', 'PermissionDeclarationV1'].join(''),
] as const;

describe('plugin permission declaration vocabulary', () => {
  it('keeps retired declaration categories absent from the owner and protocol root', () => {
    const ownerSource = readFileSync(new URL('./v1.ts', import.meta.url), 'utf8');
    const rootSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

    for (const name of retiredPermissionDeclarationNames) {
      expect(ownerSource).not.toContain(name);
      expect(rootSource).not.toContain(name);
      expect(protocol).not.toHaveProperty(name);
    }
  });
});
