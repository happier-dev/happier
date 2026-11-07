import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { Modal } from '@/modal';
import { t } from '@/text';

import { formatAgentNameList } from '@/components/capabilities/identity/agentNameList';

/** What an agent install changes, in the words of the one confirm (P9 row 21a, D22). */
export type AgentInstallChange = Readonly<{
  name: string;
  version?: string;
  /** Machines downloading as soon as the person confirms. */
  nowMachines: readonly string[];
  /** Machines that download it the first time a session uses it. */
  firstUseMachines: readonly string[];
  sizeBytes?: number | null;
  /** The download's host ("github.com"), when known. */
  sourceHost?: string | null;
  /** `consent.vendorRecipe` of the request: approving this confirm is that consent, so nothing asks twice. */
  vendorRecipe?: boolean;
}>;

/**
 * The confirm body for `agents.acp.backends.installFromRegistry`, `machines.agents.install/uninstall` and
 * `agents.acp.backends.delete`'s install side: one paragraph per fact, in the shared confirm dialog (no second dialog).
 */
export function buildAgentInstallChangeConfirm(
  change: AgentInstallChange,
): Readonly<{
  title: string;
  paragraphs: readonly Readonly<{ text: string }>[];
  confirmText: string;
}> {
  const paragraphs: string[] = [];
  if (change.nowMachines.length > 0)
    paragraphs.push(
      t('capabilities.agentAdd.confirm.now', {
        machines: formatAgentNameList(change.nowMachines),
      }),
    );
  if (change.firstUseMachines.length > 0)
    paragraphs.push(
      t('capabilities.agentAdd.confirm.firstUse', {
        machines: formatAgentNameList(change.firstUseMachines),
      }),
    );
  if (change.nowMachines.length === 0 && change.firstUseMachines.length === 0)
    paragraphs.push(t('capabilities.agentAdd.confirm.nowhere'));
  if (change.sizeBytes)
    paragraphs.push(
      t('capabilities.agentAdd.confirm.size', {
        size: formatHappierDataBytes(change.sizeBytes, { kind: 'storage' }),
      }),
    );
  if (change.sourceHost)
    paragraphs.push(
      t('capabilities.agentAdd.confirm.source', { host: change.sourceHost }),
    );
  if (change.vendorRecipe)
    paragraphs.push(
      t('capabilities.agentAdd.confirm.vendorRecipe', { name: change.name }),
    );
  return {
    title: t('capabilities.agentAdd.confirm.title', {
      name: change.name,
      version: change.version,
    }),
    paragraphs: paragraphs.map((text) => ({ text })),
    confirmText: t('capabilities.agentAdd.confirm.confirm'),
  };
}

/** Asks once through the shared confirm dialog; `true` when the person confirms. */
export function confirmAgentInstallChange(
  change: AgentInstallChange,
): Promise<boolean> {
  const body = buildAgentInstallChangeConfirm(change);
  return Modal.confirm(body.title, undefined, {
    confirmText: body.confirmText,
    messageParagraphs: body.paragraphs,
  });
}
