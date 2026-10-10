import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeSettingEntryFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();

afterEach(() => standardCleanup());

/**
 * HCLOG-10: a Home registry setting and a plugin setting are one row around one control. Each
 * adapter keeps its drafts and writes; neither draws its own label, hint or status type.
 */
describe('SchemaFieldRow', { timeout: 180_000 }, () => {
    it('is the row of a Home registry field and of a plugin settings field alike', async () => {
        const { SchemaFieldRow } = await import('./SchemaFieldRow');
        const { HomeSettingFieldRow } = await import('../home/governance/HomeSettingFieldRow');
        const { PluginSettingTextField } = await import('../plugins/detail/PluginDetailGenericSettingsSection');

        const home = await renderScreen(
            <HomeSettingFieldRow
                testID="home-row"
                entry={homeSettingEntryFixture('METRICS_PORT', {
                    value: 9090,
                    source: 'home',
                    declaration: { type: 'int', section: 'server', bounds: { min: 1 } },
                })}
                title="Metrics port"
                subtitle="Where metrics are served."
                staged={undefined}
                readOnly={false}
                disabled={false}
                error={null}
                onStage={vi.fn()}
            />,
        );
        const homeRow = home.tree.findByType(SchemaFieldRow);
        expect(homeRow.props).toMatchObject({ title: 'Metrics port', hint: 'Where metrics are served.', layout: 'adaptive' });
        standardCleanup();

        const plugin = await renderScreen(
            <PluginSettingTextField
                pluginId="acme"
                group={{ id: 'general', scope: { kind: 'account' } } as never}
                field={{ key: 'endpoint', title: 'Endpoint', subtitle: 'Where requests go.', control: 'text', redaction: 'none' } as never}
                value="https://api.example"
                dirty={false}
                saving={false}
                saveFailed={false}
                persistenceDisabled={false}
                status="Saved on this account"
                errorMessage="The address was refused"
                onChangeText={vi.fn()}
                onCommit={vi.fn()}
            />,
        );
        const pluginRow = plugin.tree.findByType(SchemaFieldRow);
        expect(pluginRow.props).toMatchObject({ title: 'Endpoint', hint: 'Where requests go.', layout: 'stacked' });
        // The field, its stored-state line and its refusal stay addressable where plugin flows find them.
        expect(plugin.findByTestId('settings.plugins.detail.acme.settings.general.endpoint.input')).not.toBeNull();
        expect(plugin.findByTestId('settings.plugins.detail.acme.settings.general.endpoint.status')).not.toBeNull();
        expect(plugin.findByTestId('settings.plugins.detail.acme.settings.general.endpoint.error')).not.toBeNull();
        expect(plugin.findByTestId('settings.plugins.detail.acme.settings.general.endpoint.save')).not.toBeNull();
    });
});
