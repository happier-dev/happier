/**
 * The replay dialog item is owned by the prompt framer that renders it
 * (`@happier-dev/agents`). This module re-exports that one type: while the CLI
 * kept a structurally identical copy, a field added at the owner — `seq`, which
 * is what lets the seed say which slice of the transcript it already carries —
 * simply never reached the retrieval side.
 */
export type { HappierReplayDialogItem } from '@happier-dev/agents';
