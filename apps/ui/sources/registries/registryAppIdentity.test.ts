import { expect, it } from 'vitest';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';
import type { DeploymentTemplateRefV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { registryAppIdentity } from './useRegistryAppIdentity';

const pin: DeploymentTemplateRefV1 = { sourceId: 'apps', itemId: 'status', version: '1', ref: { kind: 'version', version: '1' } };
const item: RegistryItemV1 = { summary: { kind: 'app', sourceId: 'apps', itemId: 'status', version: '1', title: 'Status',
    iconUrl: 'https://apps.test/light.png', iconDarkUrl: 'https://apps.test/dark.png' },
    payload: { kind: 'app', state: 'needs_review', ref: pin.ref, diagnostics: [] } };

it('uses only the pinned App identity and the shared admitted light/dark mark', () => {
    expect(registryAppIdentity(item, pin)).toMatchObject({ title: 'Status', mark: { displayName: 'Status',
        light: { uri: 'https://apps.test/light.png' }, dark: { uri: 'https://apps.test/dark.png' } } });
    expect(registryAppIdentity({ ...item, summary: { ...item.summary, version: '2' } }, pin)).toBeNull();
    expect(registryAppIdentity({ ...item, payload: { ...item.payload, ref: { kind: 'version', version: '2' } } }, pin)).toBeNull();
    expect(registryAppIdentity(null, pin)).toBeNull();
});
