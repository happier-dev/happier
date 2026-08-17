/**
 * The Sentry-owned projection of one issue.
 *
 * These shapes mirror the Triage contract's snapshot/fact vocabulary structurally
 * so the later binding to `@happier-dev/triage-protocol` is a rename rather than
 * a remapping. This package deliberately declares no shared type and imports no
 * target protocol package.
 */

import type { SentryLocatorV1 } from '../instances/sentryLocator.js';

export type SentryStatusToneV1 = 'danger' | 'warning' | 'info' | 'neutral' | 'success';

export type SentryFactValueV1 =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'status'; label: string; tone: SentryStatusToneV1 }>
  | Readonly<{
    kind: 'number';
    /** Kept as a string: `[SCHEMA]` `count` is typed string and can exceed a safe integer. */
    value: string;
    format: 'compact' | 'plain';
    approximate: boolean;
  }>
  | Readonly<{ kind: 'timestamp'; atMs: number; format: 'relative' | 'absolute' }>
  | Readonly<{ kind: 'actor'; displayName: string; actorKind: 'user' | 'team' }>
  /** The source knows the fact exists but loads it only in the detail surface. */
  | Readonly<{ kind: 'detailOnly' }>;

export type SentryFactImportanceV1 = 'primary' | 'secondary' | 'supplementary';

export type SentryRowFactV1 = Readonly<{
  id: string;
  importance: SentryFactImportanceV1;
  value: SentryFactValueV1;
}>;

export type SentryStatePresentationV1 =
  | 'active'
  | 'resolved'
  | 'suppressed'
  | 'closed'
  | 'unknown';

export type SentryEntryStateV1 = Readonly<{
  presentation: SentryStatePresentationV1;
  /** Sentry's own word, preserved beside the deliberately lossy projection. */
  nativeLabel: string;
}>;

export type SentryLocalRefV1 = Readonly<{
  kindId: 'error-issue';
  collisionScope: string;
  entryId: string;
}>;

export type SentryIssueSnapshotV1 = Readonly<{
  kindId: 'error-issue';
  localRef: SentryLocalRefV1;
  title: string;
  scopeLabel: string;
  state: SentryEntryStateV1;
  locator: SentryLocatorV1;
  facts: readonly SentryRowFactV1[];
  /** `lastSeen`, the only provider clock reading the issue model offers. */
  sourceUpdatedAtMs: number | null;
  /**
   * True when this source shortened or count-truncated displayed content.
   * False is not a claim that Sentry retained all upstream telemetry.
   */
  projectionTruncated: boolean;
}>;
