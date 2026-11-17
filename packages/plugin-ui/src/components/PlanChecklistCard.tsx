import type { ReactElement, ReactNode } from 'react';

import type { HappierStyleProp } from '../presentation/portableTypes.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type PlanChecklistPhase = 'select' | 'execute';
export type PlanChecklistItemStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';
export type PlanChecklistKind = 'item' | 'stage' | 'substep' | 'prompt';
export type PlanChecklistVariant = 'default' | 'onboarding';

export type PlanChecklistLogEntry = Readonly<{
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  details?: string;
}>;

export type PlanChecklistExecutionError = Readonly<{
  title: string;
  message?: string;
  raw?: unknown;
}>;

export type PlanChecklistExecutionState = Readonly<{
  status: PlanChecklistItemStatus;
  logs: readonly PlanChecklistLogEntry[];
  error?: PlanChecklistExecutionError;
}>;

export type PlanChecklistItem = Readonly<{
  id: string;
  kind?: PlanChecklistKind;
  title: ReactNode;
  subtitle?: ReactNode;
  satisfied: boolean;
  disabled: boolean;
  defaultSelected?: boolean;
  selected?: boolean;
  badge?: ReactNode;
  /** The run waits on the person at this row (a password, a choice); the host marks it "Needs you". */
  needsAttention?: boolean;
  children?: readonly PlanChecklistItem[];
  renderDetails?: () => ReactNode;
  details?: ReactNode | (() => ReactNode);
}>;

export type PlanChecklistCardProps = Readonly<{
  testID?: string;
  items: readonly PlanChecklistItem[];
  phase: PlanChecklistPhase;
  variant?: PlanChecklistVariant;
  selectedIds: readonly string[];
  executionById?: Readonly<Record<string, PlanChecklistExecutionState>>;
  expandedIds?: readonly string[];
  expandedId?: string | null;
  onToggleItem?: (itemId: string) => void;
  onToggleExpanded?: (itemId: string) => void;
  onCopyDiagnostics?: (item: PlanChecklistItem) => boolean | void | Promise<boolean | void>;
  header?: ReactNode;
  footer?: ReactNode;
  style?: HappierStyleProp;
  depth?: number;
  /** Shown by hosts without the same-realm deployment/onboarding checklist renderer. */
  fallback?: ReactNode;
}>;

/** The existing deployment and onboarding checklist. Callers own execution, selection and log acquisition. */
export function PlanChecklistCard({ fallback, ...input }: PlanChecklistCardProps): ReactElement {
  return <>{useOptionalPluginUiPresentationHost()?.renderPlanChecklistCard?.(input) ?? fallback}</>;
}
