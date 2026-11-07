import * as React from 'react';
import type { View } from 'react-native';

import { SessionVisualNetworkPanel } from '@/components/sessions/board/SessionVisualNetworkPanel';
import type { SessionVisualNetworkChoice } from '@/components/sessions/board/sessionBoardVisualNetwork';
import {
  readArtifactPublicNetworkResource,
  writeArtifactNetworkPolicy,
  type ArtifactPublicNetworkOpenedV1,
  type ArtifactPublicNetworkResourceV1,
} from '@/components/sharing/documents/artifactPublicNetworkPreparation';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets';
import { Modal } from '@/modal';
import { t } from '@/text';

import { useArtifactActionsClient } from './artifactActionsClient';

function holdsHtmlNetwork(artifact: DecryptedArtifact): boolean {
  const kind = (artifact.rawHeader ?? artifact.header)?.kind;
  if (kind === 'html') return true;
  if (kind !== 'widget-definition.v1' || typeof artifact.body !== 'string') return false;
  try {
    return WidgetDefinitionV1Schema.safeParse(JSON.parse(artifact.body)).data?.body.kind === 'html';
  } catch {
    return false;
  }
}

type Opened = Readonly<{
  opened: ArtifactPublicNetworkOpenedV1;
  resource: ArtifactPublicNetworkResourceV1;
}>;

/**
 * Network access for a saved HTML document: the Board's network panel on the document's own revision,
 * saved through the one artifact network writer (`artifact.update`, with its ordinary approval).
 */
export function useArtifactNetworkEditor(
  artifact: DecryptedArtifact,
  canEdit: boolean,
  anchorRef: React.RefObject<View | null>,
) {
  const client = useArtifactActionsClient();
  const [state, setState] = React.useState<Readonly<
    | { artifactId: string; phase: 'opening' }
    | ({ artifactId: string; phase: 'open' } & Opened)
  > | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const current = state?.artifactId === artifact.id ? state : null;
  // A saved HTML page, or a saved copy of an HTML visual (a widget definition with an HTML body).
  const available = canEdit && client !== null && artifact.isDecrypted !== false && holdsHtmlNetwork(artifact);
  const close = React.useCallback(() => setState(null), []);

  const open = React.useCallback(async () => {
    if (!available || !client) return;
    setState({ artifactId: artifact.id, phase: 'opening' });
    try {
      const read = await client.getArtifact(artifact.id);
      const opened = read.ok ? read.value.artifact : null;
      if (!opened)
        throw new Error(read.ok ? 'artifact_not_found' : read.failure.code);
      const resource = await readArtifactPublicNetworkResource({
        opened,
        scope: client.scope,
      });
      if (mounted.current)
        setState({ artifactId: artifact.id, phase: 'open', opened, resource });
    } catch {
      if (!mounted.current) return;
      setState(null);
      Modal.alert(t('common.error'), t('sessionBoard.item.network.failed'));
    }
  }, [artifact.id, available, client]);

  const save = React.useCallback(
    async (
      choice: SessionVisualNetworkChoice,
    ): Promise<WidgetSetupSubmitResult> => {
      if (!client || current?.phase !== 'open')
        return { ok: false, message: t('sessionBoard.item.network.failed') };
      const { opened, resource } = current;
      try {
        const written = await writeArtifactNetworkPolicy({
          opened,
          resource,
          isCurrent: () => mounted.current,
          policy: {
            network: choice.mode,
            networkOrigins:
              choice.mode === 'origins' ? [...choice.origins] : [],
          },
          request: async (_actionId, payload) => {
            const outcome = await client.updateArtifact(
              payload as Parameters<typeof client.updateArtifact>[0],
            );
            if ('approvalId' in outcome) return null;
            if (!outcome.ok) throw new Error(outcome.failure.code);
            return outcome.value;
          },
        });
        return written.kind === 'pending'
          ? { ok: true, approvalPending: true }
          : { ok: true };
      } catch {
        return { ok: false, message: t('sessionBoard.item.network.failed') };
      }
    },
    [client, current],
  );

  const panel =
    current?.phase === 'open' ? (
      <WidgetFlowShell
        anchorRef={anchorRef}
        title={t('sessionBoard.item.network.title')}
        onRequestClose={close}
        testID="artifact:networkShell"
      >
        <SessionVisualNetworkPanel
          testID="artifact:network"
          onClose={close}
          onSave={save}
          current={{
            mode: current.resource.policy.network,
            origins: current.resource.policy.networkOrigins,
          }}
        />
      </WidgetFlowShell>
    ) : null;

  return { available, opening: current?.phase === 'opening', open, panel };
}
