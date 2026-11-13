import assert from 'node:assert/strict';
import test from 'node:test';

import { collectUiActionParity } from './uiActionParity.ts';

const specs = [{ id: 'settings.set', surfaces: { ui: true, agent: true, mcp: true, cli: true } }];

test('pane geometry exemptions preserve detection of unrelated settings writes in the same component', () => {
  const report = collectUiActionParity([{
    filePath: 'apps/ui/sources/components/appShell/panes/PaneColumnsHost.tsx',
    content: `
      getStorage().getState().applyLocalSettings({ rightPaneWidthPx: width }, { source: 'ui' });
      getStorage().getState().applyLocalSettings({ futurePreference: next }, { source: 'ui' });
    `,
  }], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['direct_settings_write', 'applyLocalSettings'],
  ]);
  assert.deepEqual(report.settings.map(site => site.key), ['rightPaneWidthPx', 'futurePreference']);
  assert.equal(report.exclusions.length, 1);
});

test('remote settings reconciliation exemption remains exact to the audited snapshot operand', () => {
  const report = collectUiActionParity([{
    filePath: 'apps/ui/sources/sync/engine/settings/syncSettings.ts',
    content: `
      storage.getState().applySettings(nextSettings, nextVersion, remoteAlertPolicyStatus);
      storage.getState().applySettings(unreviewedDelta);
    `,
  }], specs, []);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['dynamic_setting', 'Identifier'],
  ]);
  assert.equal(report.exclusions.length, 1);
});

test('composed setting pages and finite indexed refs retain declaration admission and unavailable findings', () => {
  const report = collectUiActionParity([
    {
      filePath: 'apps/ui/sources/components/settings/session/sessionSettings.ts',
      content: `const SESSION_PAGE = defineSettingsPage({
        pageId: 'session', sections: { prompt: { settings: { renameSessions: {}, unavailable: {} } } },
      });
      export const SESSION_SETTINGS = { ...SESSION_PAGE, settings: { ...SESSION_PAGE.settings,
        collapsedGroups: { anchor: 'session.list.collapsedGroups' },
      } };`,
    },
    {
      filePath: 'apps/ui/sources/components/settings/session/Control.tsx',
      content: `
        import { SESSION_SETTINGS as rows } from './sessionSettings';
        import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
        const { setSetting } = useSettingActionFeedback();
        setSetting(rows.settings.renameSessions, 'automatic');
        const roleSettings = { normal: rows.settings.renameSessions, protected: rows.settings.unavailable } as const;
        function select(role: keyof typeof roleSettings) { setSetting(roleSettings[role], 'automatic'); }
        setSetting(rows.settings.unavailable, true);
      `,
    },
  ], specs, [
    { anchor: 'session.renameSessions', storage: { scope: 'account', key: 'renameSessions', access: 'read_write' } },
    { anchor: 'session.unavailable', surfaces: { agent: false }, storage: { scope: 'account', key: 'unavailable', access: 'read_write' } },
  ]);
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set', 'settings.set']);
  assert.deepEqual(report.findings.map(site => [site.code, site.operation]), [
    ['agent_unavailable', 'settings.set:session.unavailable'],
    ['agent_unavailable', 'settings.set:session.unavailable'],
  ]);
});
