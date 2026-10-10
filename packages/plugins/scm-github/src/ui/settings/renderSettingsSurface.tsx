/**
 * The GitHub PRs & Issues settings surface artifact entry.
 *
 * The page itself is `@happier-dev/triage-sources`. Every source's page
 * reads the same three published contracts — this source's own `listInstances`,
 * the target's caller-scoped configured-instance read, and the target's single
 * administration Action — and reaches the same conclusions from the same bytes,
 * so it is written once. GitHub contributes its identity, discovery Action and
 * display name, plus the source-native scope editor. The shared page still owns
 * configured-row matching, lifecycle and submission.
 *
 * This file is that contribution AND the module the manifest's
 * `github-triage-sources-native` artifact is built from, so the exported name
 * stays `renderSurface`.
 */

import * as React from 'react';
import { Button, ErrorState, Item, ItemGroup, Row, Select, Stack, TextField, usePluginTranslation } from '@happier-dev/plugin-ui';
import { createTriageSourceSettingsSurface, type TriageSourceSettingsDraftEditorPropsV1 } from '@happier-dev/triage-sources';

import { GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_TRIAGE_ACTION_IDS_V1,
  GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
} from '../../triage/contribution.js';
import { decodeGithubTriageConfiguration, encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { buildGithubRepositoryKey } from '../../triage/locator.js';

/** Only GitHub's opaque configuration changes; the shared page owns submission and lifecycle. */
function GithubScopeDraftEditor(props: TriageSourceSettingsDraftEditorPropsV1): React.ReactElement {
  // A different discovered row gets its own unsaved inputs, not the previous login's scope.
  return <GithubScopeDraftFields key={JSON.stringify([props.draft.binding, props.draft.localInstanceKey, props.draft.configuration])} {...props} />;
}

function GithubScopeDraftFields({ draft, busy, onSubmit, onCancel }: TriageSourceSettingsDraftEditorPropsV1): React.ReactElement {
  const text = usePluginTranslation();
  const decoded = decodeGithubTriageConfiguration(draft.configuration.token);
  const [scope, setScope] = React.useState<'account' | 'repository'>(() => decoded.ok ? decoded.configuration.scope.kind : 'account');
  const [repository, setRepository] = React.useState(() => decoded.ok && decoded.configuration.scope.kind === 'repository'
    ? decoded.configuration.scope.repositoryKey : '');
  const segments = repository.split('/');
  const repositoryKey = segments.length === 2 ? buildGithubRepositoryKey({ owner: segments[0], name: segments[1] }) : null;
  const token = scope === 'account'
    ? encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } })
    : repositoryKey === null ? null : encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey } });
  const cancel = <Button title={text('plugins.github.settings.scope.cancel', 'Cancel')} variant="secondary" disabled={busy} onPress={onCancel} />;

  if (!decoded.ok) {
    return <ErrorState
      title={text('plugins.triage.sourceSettings.unreadable.title', 'This version cannot read the response')}
      description={text('plugins.triage.sourceSettings.unreadable.description', 'The {source} source returned a result outside the published contract.', { source: 'GitHub' })}
      action={cancel}
    />;
  }
  return (
    <Stack gap="small">
      <ItemGroup
        title={text('plugins.github.settings.scope.heading', 'GitHub scope')}
        description={text('plugins.github.settings.scope.description', 'Show all repositories this login can reach, or choose one repository for PRs & Issues.')}
      >
        <Item title={text('plugins.github.settings.scope.label', 'Scope')}>
          <Select
            label={text('plugins.github.settings.scope.label', 'Scope')}
            presentation="segmented"
            value={scope}
            options={[
              { value: 'account', label: text('plugins.github.settings.scope.account', 'All repositories') },
              { value: 'repository', label: text('plugins.github.settings.scope.repository', 'Repository') },
            ]}
            disabled={busy}
            onChange={(value) => { if (value === 'account' || value === 'repository') setScope(value); }}
          />
        </Item>
        {scope === 'repository' ? (
          <Item title={text('plugins.github.settings.scope.repository', 'Repository')}>
            <TextField
              label={text('plugins.github.settings.scope.repository', 'Repository')}
              presentation="field"
              placeholder={text('plugins.github.settings.scope.repositoryHint', 'owner/repository')}
              value={repository}
              onChange={setRepository}
              autoCapitalize="none"
              autoCorrect={false}
              disabled={busy}
              required
              error={repository.trim() !== '' && repositoryKey === null
                ? text('plugins.github.settings.scope.invalidRepository', 'Enter a repository as owner/repository.') : undefined}
            />
          </Item>
        ) : null}
      </ItemGroup>
      <Row gap="small">
        <Button
          title={text('plugins.github.settings.scope.save', 'Save scope')}
          variant="primary"
          busy={busy}
          disabled={busy || token === null}
          onPress={() => {
            if (busy || token === null) return;
            void onSubmit({ ...draft, configuration: { v: 1, token } });
          }}
        />
        {cancel}
      </Row>
    </Stack>
  );
}

export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: GITHUB_PLUGIN_ID,
  listInstancesLocalActionId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances,
  connectedAccountServiceLocalId: GITHUB_CONNECTED_ACCOUNT_ID,
  sourceDisplayName: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName,
  DraftEditor: GithubScopeDraftEditor,
  nativeLoginLabel: {
    key: 'plugins.github.settings.nativeLogin',
    fallback: 'Use this machine’s GitHub CLI login',
  },
  nativeAuthenticationFailureLabel: {
    key: 'plugins.github.settings.nativeLoginUnavailable',
    fallback: 'Sign in with gh CLI on this machine.',
  },
});
