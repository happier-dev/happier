import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { selectTargetedContributionSurface } from '@happier-dev/plugin-sdk/ui';
import {
  defineUiSurface,
  Button,
  Screen,
  Stack,
  Status,
  TargetedSurface,
  Text,
  useComposer,
  useComposerView,
  useExecutePluginAction,
  useLivePluginResource,
} from '@happier-dev/plugin-ui';

import { QA_REVISION } from '../revision.js';
import { qaProtocol } from '../protocol.js';

/** The exact bytes this generation's dynamic Resource must read back. */
const RESOURCE_SENTINEL = `qa-current-source-resource-${QA_REVISION}`;

/** The mounted surface is ASCII-only by construction; fail closed on anything else. */
function decodeResourceBytes(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * Observes the fixture's public dynamic Resource through the real host
 * Resource store and exercises the fixture's daemon Action through the shared
 * execution owner. Every sentinel is revision-qualified, so browser (RNW) and
 * native prove the same loaded generation from one shared surface.
 */
function CurrentSourceResourceAndAction() {
  const { resource } = useLivePluginResource('qa-resource');
  const resourceValue = resource.value && resource.value.contentType === 'text/plain'
    ? decodeResourceBytes(resource.value.bytes)
    : null;
  const selfCheck = useExecutePluginAction('qa-self-check');
  const result = selfCheck.execution.status === 'success'
    ? (selfCheck.execution.result as { revision?: unknown } | null)
    : null;
  const resultRevision = result && typeof result.revision === 'string' ? result.revision : null;

  return (
    <Stack gap="medium">
      {resourceValue === RESOURCE_SENTINEL
        ? <Text testID={RESOURCE_SENTINEL} value={`Current source resource ${resourceValue}`} />
        : <Status tone="warning" testID="qa-current-source-resource-missing" label="Current source resource unavailable" />}
      <Button
        testID="qa-current-source-action-run"
        title={`Run self-check ${QA_REVISION}`}
        busy={selfCheck.execution.status === 'pending'}
        onPress={() => { void selfCheck.execute({}); }}
      />
      {selfCheck.execution.status === 'pending'
        ? <Status tone="info" testID="qa-current-source-action-busy" label={`Self-check busy ${QA_REVISION}`} />
        : null}
      {selfCheck.execution.status === 'success' && resultRevision === QA_REVISION
        ? (
          <Stack gap="small">
            <Status tone="success" testID="qa-current-source-action-settled" label="Self-check settled" />
            <Text
              testID={`qa-current-source-action-result-${resultRevision}`}
              value={`Self-check result ${resultRevision}`}
            />
          </Stack>
        )
        : null}
      {(selfCheck.execution.status === 'error' || selfCheck.execution.status === 'outcomeUnknown')
        ? <Status tone="danger" testID="qa-current-source-action-failed" label="Self-check failed" />
        : null}
    </Stack>
  );
}

function CurrentSourceNativeSurface({ context }: Readonly<{ context: RenderContext }>) {
  const composer = useComposer();
  const composerView = useComposerView(composer.current());
  const mount = context.surface.mount;

  if (mount.kind === 'embedded' && mount.role === 'detail') {
    return <Status tone="info" testID={`qa-current-source-targeted-${QA_REVISION}`} label={`Current source targeted ${QA_REVISION}`} />;
  }
  if (mount.kind === 'embedded') {
    return <Status tone="info" testID="qa-current-source-composer-region" label="Current source Composer region mounted" />;
  }

  const targeted = context.surface.targetedContributions
    ? selectTargetedContributionSurface(context.surface.targetedContributions, {
        pointId: 'sources',
        protocol: { id: qaProtocol.id, version: qaProtocol.version },
        contributor: { pluginId: context.plugin.id, contributionId: 'qa-source' },
        role: 'detail',
      })
    : null;

  return (
    <Screen>
      <Stack gap="medium">
        <Text testID={`qa-current-source-rn-${QA_REVISION}`} value={`Current source native ${QA_REVISION}`} />
        <Status tone="info"
          testID="qa-current-source-composer-facts"
          label={composerView.result?.status === 'ready'
            ? `${composerView.result.snapshot.attachments.length} attachments, ${composerView.result.snapshot.references.length} references`
            : 'Composer unavailable'}
        />
        <CurrentSourceResourceAndAction />
        {targeted ? <TargetedSurface surface={targeted} input={{ qaId: 'native-row' }} instanceKey="native-row" /> : null}
      </Stack>
    </Screen>
  );
}

export const renderSurface = defineUiSurface((context) => <CurrentSourceNativeSurface context={context} />);
