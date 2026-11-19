import { z } from 'zod/mini';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readSessionAuthoredDisplayV1 } from '@happier-dev/protocol/sessions/metadata/sessionDisplaySchemasV1';
import type { SessionStateBinding } from '../_types.js';

/** An annotation only; the metadata CAS owns replacement and clearing. */
export const sessionStatusReasonBinding: SessionStateBinding<'display.statusReason'> = {
  read: metadata => {
    const display = readSessionAuthoredDisplayV1(metadata.work);
    return { value: display?.statusReason ?? null, updatedAt: display?.statusReasonSetAt ?? null };
  },
  write: (metadata, update) => {
    const reason = z.nullable(z.string()).parse(update.value);
    const previousWork = readRecord(metadata.work);
    if (reason === null) {
      if (!('statusReason' in previousWork)) return metadata;
      const { statusReason: _previous, statusReasonSetAt: _setAt, ...work } = previousWork;
      return { ...metadata, work };
    }
    if ('statusReason' in previousWork && previousWork.statusReason === reason) return metadata;
    return { ...metadata, work: { ...previousWork, statusReason: reason, statusReasonSetAt: update.updatedAt ?? Date.now() } };
  },
};

export const sessionStatusProgressBinding: SessionStateBinding<'display.statusProgress'> = {
  read: metadata => ({
    value: readSessionAuthoredDisplayV1(metadata.work)?.statusProgress ?? null,
    updatedAt: null,
  }),
  readMutationBasis: metadata => readSessionAuthoredDisplayV1(metadata.work) ?? null,
  write: (metadata, { value }) => {
    const next = value === 'clear' ? sessionStatusReasonBinding.write(metadata, { value: null }) : metadata;
    const work = readRecord(next.work);
    if (value === null || value === 'clear') {
      if (!('statusProgress' in work)) return next;
      const { statusProgress: _previous, ...remaining } = work;
      return { ...next, work: remaining };
    }
    const previous = readSessionAuthoredDisplayV1(work)?.statusProgress;
    if (previous?.done === value.done && previous.total === value.total && previous.label === value.label) return next;
    return { ...next, work: { ...work, statusProgress: value } };
  },
};
