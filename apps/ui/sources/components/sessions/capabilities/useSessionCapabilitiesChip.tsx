import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { MetadataSchema } from '@happier-dev/session-core/state';

import type { CapabilityCost } from '@/components/capabilities/facts/CapabilityFacts';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type {
  AgentInputExtraActionChip,
  AgentInputStatusBadge,
} from '@/components/sessions/agentInput/agentInputContracts';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useSkillComposerSource } from '@/sync/domains/skills/useSkillComposerSource';
import type { SkillComposerSource } from '@/sync/domains/skills/skillComposerGroups';
import { t } from '@/text';

import {
  createCapabilitiesActionChip,
  SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO,
} from './createCapabilitiesActionChip';
import {
  SessionCapabilitiesContent,
  type SessionCapabilitiesChange,
  type SessionCapabilitiesUndo,
} from './SessionCapabilitiesContent';
import {
  buildSessionCapabilitiesModel,
  type SessionCapabilitiesLastKnown,
  type SessionCapabilitiesModel,
  type SessionCapabilitiesModelInput,
} from './sessionCapabilitiesModel';
import { useSessionCapabilitiesOpenRequest } from './sessionCapabilitiesRoute';
import { useSessionCapabilityRestart } from './sessionCapabilityRestart';
import {
  useExistingSessionCapabilitiesPopover,
  useNewSessionCapabilitiesPopover,
  type NewSessionCapabilitiesDraft,
  type SessionCapabilitiesTarget,
} from './useSessionCapabilitiesPopover';

import { CLOSED_DETAIL, useSessionCapabilitiesDetail, type Detail, type SheetTarget, type ModelInput } from './useSessionCapabilitiesDetail';
export { CLOSED_DETAIL, useSessionCapabilitiesDetail, type SheetTarget } from './useSessionCapabilitiesDetail';
type Base = Omit<
  SessionCapabilitiesModelInput,
  keyof Detail | keyof ModelInput
>;

/** The open sheet: mounts the detail owners, projects the full model and renders the shared body. */
function SessionCapabilitiesSheet(
  props: Readonly<{
    serverId: string | null;
    base: Base;
    modelInput: ModelInput;
    onAttention: (attention: boolean) => void;
    onChange: SessionCapabilitiesChange;
    onRetry: (factsKey?: string) => void;
    machineName: string;
    maxHeight: number;
    target: SheetTarget;
    undo?: SessionCapabilitiesUndo | null;
    /** What the chip remembers of this Session's last sheet (read once, when the sheet opens). */
    readKnown: () => SessionCapabilitiesLastKnown | null;
    onKnown: (known: SessionCapabilitiesLastKnown) => void;
  }>,
) {
  const router = useRouter();
  const [known] = React.useState(props.readKnown);
  const { detail, renderMark } = useSessionCapabilitiesDetail(
    props.serverId,
    props.base.machineOnline === undefined ? true : props.base.machineOnline,
    props.onRetry,
    props.target,
    props.modelInput,
    props.machineName,
    known?.costs,
  );
  const model = React.useMemo(
    () =>
      buildSessionCapabilitiesModel({
        ...props.base,
        ...detail,
        ...props.modelInput,
      }),
    [props.base, detail, props.modelInput],
  );
  const { onAttention } = props;
  React.useLayoutEffect(
    () => onAttention(model.attention),
    [onAttention, model.attention],
  );
  // The chip keeps what this sheet now knows, so the next open holds its size and its cost facts.
  const { onKnown } = props;
  const { view } = props.modelInput;
  React.useEffect(() => {
    if (view === null) return;
    const costs = new Map<string, CapabilityCost>();
    for (const item of [...view.skills.items, ...view.mcp.items]) {
      const cost = detail.cost?.(item.kind, item.id);
      if (cost) costs.set(`${item.kind}:${item.id}`, cost);
    }
    onKnown({ rows: { skills: model.groups[0].rows.length, mcp: model.groups[1].rows.length }, costs });
  }, [view, detail, model.groups, onKnown]);
  const onOpen = React.useCallback(
    (destination: 'skills' | 'mcp') =>
      router.push(
        (destination === 'skills'
          ? SETTINGS_ROUTES.skills
          : SETTINGS_ROUTES.mcp) as never,
      ),
    [router],
  );
  return (
    <SessionCapabilitiesContent
      model={model}
      onChange={props.onChange}
      undo={props.undo}
      onRetry={props.onRetry}
      onOpen={onOpen}
      renderMark={renderMark}
      machineName={props.machineName}
      maxHeight={props.maxHeight}
      knownRows={known?.rows}
      testID="session-capabilities"
    />
  );
}

function useCapabilitiesChip(
  params: Readonly<{
    placementId?: string;
    model: SessionCapabilitiesModel;
    modelInput: ModelInput;
    base: Base;
    stabilityKey: string;
    serverId: string | null;
    machineName: string;
    onChange: SessionCapabilitiesChange;
    onRetry: (factsKey?: string) => void;
    demandPreview: () => void;
    openRequest?: Readonly<{ consume: () => void }> | null;
    target: SheetTarget;
    undo?: SessionCapabilitiesUndo | null;
  }>,
): AgentInputExtraActionChip {
  const { height } = useWindowDimensions();
  // Last known from the open sheet; the closed chip reads no statuses of its own.
  const [sheetAttention, setSheetAttention] = React.useState(false);
  const {
    model,
    modelInput,
    base,
    stabilityKey,
    serverId,
    machineName,
    onChange,
    onRetry,
    demandPreview,
    openRequest,
    target,
    undo,
  } = params;
  // Unknown is never zero: until the first preview the chip names what it holds, not "0 skills".
  const label = modelInput.view ? model.chipLabel : `${t('capabilities.skills.title')} · MCP`;
  const attention = model.attention || sheetAttention;
  // What this Session's sheet last knew (its rows and cost facts), in memory only: the chip outlives the open sheet.
  const knownRef = React.useRef<Readonly<{ key: string; known: SessionCapabilitiesLastKnown }> | null>(null);
  const readKnown = React.useCallback(
    () => (knownRef.current?.key === stabilityKey ? knownRef.current.known : null),
    [stabilityKey],
  );
  const onKnown = React.useCallback(
    (known: SessionCapabilitiesLastKnown) => {
      knownRef.current = { key: stabilityKey, known };
    },
    [stabilityKey],
  );
  return React.useMemo(
    () =>
      createCapabilitiesActionChip({
        placementId: params.placementId,
        label,
        attention,
        stabilityKey,
        onIntent: demandPreview,
        openRequest,
        maxHeightCap: Math.round(
          height * SESSION_CAPABILITIES_POPOVER_HEIGHT_RATIO,
        ),
        popoverContent: ({ maxHeight }) => (
          <SessionCapabilitiesSheet
            serverId={serverId}
            base={base}
            modelInput={modelInput}
            onAttention={setSheetAttention}
            onChange={onChange}
            onRetry={onRetry}
            machineName={machineName}
            maxHeight={maxHeight}
            target={target}
            undo={undo}
            readKnown={readKnown}
            onKnown={onKnown}
          />
        ),
      }),
    [
      readKnown,
      onKnown,
      label,
      attention,
      modelInput,
      base,
      stabilityKey,
      serverId,
      machineName,
      onChange,
      onRetry,
      demandPreview,
      openRequest,
      height,
      target,
      undo,
      params.placementId,
    ],
  );
}

/**
 * The composer chip for a new-session draft, a workflow default or step override, and a trigger: "This
 * session gets" edits only the draft (P2 `useNewSessionCapabilities`); nothing is written until launch.
 */
export function useNewSessionCapabilitiesChip(
  params: Readonly<{
    placementId?: string;
    draft: NewSessionCapabilitiesDraft;
    machineName: string;
    /** REACH's presence for the draft's machine; omitted where no machine is chosen yet (authoring). */
    machineOnline?: boolean | null;
  }>,
): Readonly<{
  chip: AgentInputExtraActionChip;
  model: SessionCapabilitiesModel;
  /** The composer `$` source: a library pick edits this same draft. */
  skillSource: SkillComposerSource | null;
}> {
  const machineOnline = params.machineOnline;
  const closedInput = React.useMemo(
    () => ({ ...CLOSED_DETAIL, ...(machineOnline === undefined ? {} : { machineOnline }) }),
    [machineOnline],
  );
  const popover = useNewSessionCapabilitiesPopover(params.draft, closedInput);
  const { setItem, refresh } = popover;
  const onChange = React.useCallback<SessionCapabilitiesChange>(
    async (change) => setItem(change.kind, change.id, change.state),
    [setItem],
  );
  const onRetry = React.useCallback((factsKey?: string) => {
    void refresh(factsKey);
  }, [refresh]);
  const draft = params.draft;
  const target = React.useMemo<SheetTarget>(() => ({ draft: { machineId: draft.machineId, directory: draft.directory,
    agentId: draft.agentId, projectKey: draft.projectKey } }), [draft.machineId, draft.directory, draft.agentId, draft.projectKey]);
  const stabilityKey = `draft:${draft.machineId ?? ''}:${draft.directory}:${draft.agentId}:${draft.targetServerId ?? ''}`;
  // The open sheet names the draft's machine (offline line, "<machine>'s copy wins").
  const machineName = params.machineName;
  const base = React.useMemo<Base>(
    () => ({ machineName, ...(machineOnline === undefined ? {} : { machineOnline }) }),
    [machineName, machineOnline],
  );
  const chip = useCapabilitiesChip({
    placementId: params.placementId,
    model: popover.model,
    modelInput: popover.modelInput,
    base,
    stabilityKey,
    serverId: draft.targetServerId ?? null,
    machineName: params.machineName,
    onChange,
    onRetry,
    demandPreview: popover.demandPreview,
    target,
  });
  const skillSource = useSkillComposerSource({ serverId: draft.targetServerId ?? null, agentId: draft.agentId,
    machineId: draft.machineId ?? null, machineName: params.machineName, owner: setItem });
  return { chip, model: popover.model, skillSource };
}

/**
 * The composer chip and the one apply line for an existing session: P2's session owner writes through
 * `session.capabilities.set` (optimistic, rolled back on failure, Undo resends the previous override).
 */
export function useExistingSessionCapabilitiesChip(
  params: Readonly<{
    target: Extract<SessionCapabilitiesTarget, { kind: 'session' }>;
    machineName: string;
    machineOnline: boolean | null;
    /** No turn running and no approval waiting: the D34 Restart may run. */
    turnSettled: boolean;
    stop: () => Promise<boolean>;
    resume: () => Promise<boolean>;
  }>,
): Readonly<{
  chip: AgentInputExtraActionChip;
  model: SessionCapabilitiesModel;
  applyBadge: AgentInputStatusBadge | null;
  undoLast: () => Promise<unknown>;
  /** The composer `$` source: a library pick writes through this Session's own controller and apply line. */
  skillSource: SkillComposerSource | null;
}> {
  const { machineName, machineOnline, turnSettled } = params;
  const base = React.useMemo<Base>(
    () => ({ machineName, machineOnline, turnSettled }),
    [machineName, machineOnline, turnSettled],
  );
  const input = React.useMemo(() => ({ ...CLOSED_DETAIL, ...base }), [base]);
  const popover = useExistingSessionCapabilitiesPopover(params.target, input);
  const { setItem, refresh } = popover;
  const sessionId = params.target.sessionId;
  const target = React.useMemo<SheetTarget>(() => ({ sessionId, metadata: popover.metadata }), [sessionId, popover.metadata]);
  const onChange = React.useCallback<SessionCapabilitiesChange>(
    async (change) => {
      const result = await setItem(change.kind, change.id, change.state);
      // P2 already rolled the row back; say so once on the app's notice owner.
      if (!result.ok && result.message !== 'read_only') {
        publishPresentationNotice({
          key: `session-capabilities:${sessionId}`,
          message: t('capabilities.control.changeFailed'),
          severity: 'error',
        });
      }
      return result;
    },
    [setItem, sessionId],
  );
  const onRetry = React.useCallback((factsKey?: string) => {
    void refresh(factsKey);
  }, [refresh]);
  const { undoReceipt, undoLast } = popover;
  const undo = React.useMemo<SessionCapabilitiesUndo | null>(
    () =>
      undoReceipt
        ? {
            title: undoReceipt.title,
            change: undoReceipt.change,
            onUndo: () => {
              void undoLast().then((result) => {
                if (!result.ok && result.message !== 'read_only') {
                  publishPresentationNotice({
                    key: `session-capabilities:${sessionId}`,
                    message: t('capabilities.control.changeFailed'),
                    severity: 'error',
                  });
                }
              });
            },
          }
        : null,
    [undoReceipt, undoLast, sessionId],
  );
  const route = useSessionCapabilitiesOpenRequest();
  const { consume } = route;
  const openRequest = React.useMemo(
    () => (route.requested ? { consume } : null),
    [route.requested, consume],
  );
  const chip = useCapabilitiesChip({
    model: popover.model,
    modelInput: popover.modelInput,
    base,
    stabilityKey: `session:${sessionId}`,
    serverId: params.target.serverId,
    machineName,
    onChange,
    onRetry,
    demandPreview: popover.demandPreview,
    openRequest,
    target,
    undo,
  });
  const { badge } = useSessionCapabilityRestart({
    notice: popover.model.applyNotice,
    stop: params.stop,
    resume: params.resume,
  });
  const sessionMetadata = React.useMemo(() => {
    const parsed = MetadataSchema.safeParse(popover.metadata);
    return parsed.success ? parsed.data : null;
  }, [popover.metadata]);
  const skillSource = useSkillComposerSource({ serverId: params.target.serverId,
    agentId: sessionMetadata ? resolveAgentIdFromSessionMetadata(sessionMetadata) : null,
    machineId: sessionMetadata?.machineId ?? null, machineName, owner: setItem,
    applyTiming: popover.applyTiming?.skills ?? null });
  return {
    chip,
    model: popover.model,
    applyBadge: badge,
    undoLast: popover.undoLast,
    skillSource,
  };
}
