import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Metro importAll evaluates RN's unrelated native getters, including removed
// PushNotificationIOS. These owners need only named Platform/Linking exports.
it.each([
    './registryHostDeps.ts',
    '../sync/ops/actions/connectedServiceActionDeps.ts',
])('does not enumerate the react-native namespace in %s', path => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bimport\s*\(\s*['"]react-native['"]\s*\)/);
});
