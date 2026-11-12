import { expect, it, vi } from 'vitest';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// Vitest isolates this module; static collection exercises the same cold graph as settings search.
import { SETTINGS_PAGE_DECLARATIONS } from '@/components/settings/catalog/settingsPageDeclarations';
import { APPEARANCE_GLASS_SETTINGS } from '@/components/settings/appearance/appearanceSettings';

it('cold-loads the settings catalog with the glass declarations reachable', () => {
    expect(SETTINGS_PAGE_DECLARATIONS).toContain(APPEARANCE_GLASS_SETTINGS);
});
