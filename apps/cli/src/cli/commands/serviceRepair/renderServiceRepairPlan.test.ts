import { describe, expect, it } from 'vitest';

import { renderServiceRepairPlan } from './renderServiceRepairPlan';

function stripAnsi(value: string): string {
    return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('renderServiceRepairPlan', () => {
    it('surfaces the current default server when migrating a legacy pinned service to default-following mode', () => {
        const rendered = stripAnsi(renderServiceRepairPlan({
            commandPath: 'happier service',
            plan: {
                actions: [
                    {
                        kind: 'install-default-following-service',
                        command: 'happier service install --yes',
                        mode: 'user',
                        targetServerUrl: 'https://relay.example.test',
                    },
                ],
                manualWarnings: [],
            },
        }));

        expect(rendered).toContain('Current default server: https://relay.example.test');
        expect(rendered).toContain('happier service install --yes');
    });
});
