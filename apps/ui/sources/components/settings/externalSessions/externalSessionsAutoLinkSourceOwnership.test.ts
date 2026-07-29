import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const externalSessionsSettingsDirectory = fileURLToPath(new URL('./', import.meta.url));
const externalSessionsSettingsViewPath = fileURLToPath(
    new URL('./ExternalSessionsSettingsView.tsx', import.meta.url),
);
const agentSettingsRoutePath = fileURLToPath(
    new URL('../../../app/(app)/settings/agents/[agentId].tsx', import.meta.url),
);

describe('External Sessions automatic-link settings ownership', () => {
    it('keeps policy removal in one shared global and Agent-detail owner', () => {
        const productionPaths = [
            agentSettingsRoutePath,
            externalSessionsSettingsViewPath,
            ...readdirSync(externalSessionsSettingsDirectory)
                .filter((name) => (
                    (name.endsWith('.ts') || name.endsWith('.tsx'))
                    && !name.includes('.test.')
                    && name !== 'ExternalSessionsSettingsView.tsx'
                ))
                .map((name) => `${externalSessionsSettingsDirectory}${name}`),
        ];
        const removalOwners = productionPaths.filter((path) => (
            readFileSync(path, 'utf8').includes(
                'removeExternalSessionsAutoLinkSourcePolicyV1',
            )
        ));

        expect(removalOwners).toHaveLength(1);
        expect(removalOwners[0]?.startsWith(externalSessionsSettingsDirectory)).toBe(true);
    });
});
