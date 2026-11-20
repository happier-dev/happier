import * as React from 'react';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import type { ShareSheetAnchor } from '@/components/sharing/presentShareSheet';
import { readArtifactAudience } from '@/sync/domains/artifacts/artifactAudience';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import {
  subscribeHomeAccountChange,
  subscribeHomeCredentialChange,
} from '@/sync/runtime/orchestration/homeAccountChange';

export type PrivateDocumentShareOffer = Readonly<{
  artifactId: string;
  kind: string | null;
  title: string;
}>;

type HeldOffer = PrivateDocumentShareOffer &
  Readonly<{
    serverId: string;
    hostKey: string;
    isCurrent: () => boolean;
  }>;

/** One attach about to run: captured before the writer, so the audience read belongs to the same Account. */
export type PrivateDocumentAttach = Readonly<{
  /** Call once the host's own writer applied the attachment. */
  afterApplied: (
    document: Readonly<{ title: string; kind: string | null }>,
  ) => Promise<void>;
}>;

/**
 * "Only yours" after attaching a document to something other people read (a Team Project's Context, a Source's
 * suggested first task). Attaching never grants anything: the owner of a private document is offered the one
 * document share sheet, and only the admitted audience decides that the document is private. Each host keeps its
 * own writer and copy; `hostKey` names the place the offer belongs to, so another host never shows it.
 */
export function usePrivateAttachedDocumentShareOffer(
  input: Readonly<{
    serverId: string;
    hostKey: string;
    /** The share sheet's subtitle: where the document is attached. */
    sheetSubtitle: string;
  }>,
) {
  const { serverId, hostKey, sheetSubtitle } = input;
  const [held, setHeld] = React.useState<HeldOffer | null>(null);

  React.useEffect(() => {
    if (!held) return;
    const stopAccount = subscribeHomeAccountChange((event) => {
      if (!areServerProfileIdentifiersEquivalent(event.serverId, held.serverId))
        return;
      if (event.changeKinds && !event.changeKinds.includes('artifact')) return;
      if (event.entityIds && !event.entityIds.includes(held.artifactId)) return;
      setHeld(null);
    });
    const stopCredential = subscribeHomeCredentialChange((event) => {
      if (areServerProfileIdentifiersEquivalent(event.serverId, held.serverId))
        setHeld(null);
    });
    return () => {
      stopAccount();
      stopCredential();
    };
  }, [held]);

  const beginAttach = React.useCallback(
    (ref: PromptArtifactRefV1): PrivateDocumentAttach | null => {
      setHeld(null);
      const lifetime = captureActiveServerAccountScopeLifetime();
      const client =
        lifetime?.isCurrent() &&
        areServerProfileIdentifiersEquivalent(
          lifetime.scope.serverId,
          serverId,
        ) &&
        areServerProfileIdentifiersEquivalent(
          lifetime.scope.serverId,
          ref.serverId ?? serverId,
        )
          ? createArtifactActionsClient(lifetime.scope)
          : null;
      if (!lifetime || !client) return null;
      return {
        afterApplied: async (document) => {
          if (!lifetime.isCurrent()) return;
          const artifact = getStorage().getState().artifacts[ref.artifactId];
          if (
            !artifact?.isDecrypted ||
            artifact.access !== 'owner' ||
            artifact.ownerAccountId !== lifetime.scope.accountId
          )
            return;
          const audience = await readArtifactAudience({
            current: {
              artifactId: artifact.id,
              header: artifact.header ?? {},
              access: artifact.access,
              ownerAccountId: artifact.ownerAccountId,
              publicAudience: artifact.publicAudience,
            },
            readGrants: async () => {
              const outcome = await client.listAccessGrants(artifact.id);
              if (!outcome.ok) throw new Error(outcome.failure.code);
              return outcome.value;
            },
          });
          const isCurrent = () =>
            lifetime.isCurrent() &&
            getStorage().getState().artifacts[artifact.id] === artifact;
          // Attachment grants nothing; only the admitted audience can establish that this Doc is private.
          if (isCurrent() && audience?.shared === false) {
            setHeld({
              artifactId: ref.artifactId,
              kind: document.kind,
              title: document.title,
              serverId,
              hostKey,
              isCurrent,
            });
          }
        },
      };
    },
    [hostKey, serverId],
  );

  const open = React.useCallback(
    (offer: PrivateDocumentShareOffer, anchor?: ShareSheetAnchor) => {
      showDocumentShareSheet({
        ...(anchor ? { anchor } : {}),
        artifactId: offer.artifactId,
        kind: offer.kind,
        name: offer.title,
        subtitle: sheetSubtitle,
      });
    },
    [sheetSubtitle],
  );

  const dismiss = React.useCallback(() => setHeld(null), []);
  /** A removed attachment takes its offer with it. */
  const clear = React.useCallback(
    (artifactId: string) =>
      setHeld((current) =>
        current?.artifactId === artifactId ? null : current,
      ),
    [],
  );

  const offer: PrivateDocumentShareOffer | null =
    held &&
    held.hostKey === hostKey &&
    areServerProfileIdentifiersEquivalent(held.serverId, serverId) &&
    held.isCurrent()
      ? held
      : null;
  return { offer, beginAttach, open, dismiss, clear };
}
