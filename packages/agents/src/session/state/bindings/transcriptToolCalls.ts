import { z } from 'zod';
import type { SessionStateBinding } from '../_types.js';

/** A private presentation choice, arbitrated only by the Account metadata CAS. */
export const transcriptToolCallsBinding: SessionStateBinding<'view.transcriptToolCalls'> = {
  read: (metadata) => {
    const work = metadata.work;
    const viewPreferences = work && typeof work === 'object' && 'viewPreferences' in work
      ? work.viewPreferences : undefined;
    const value = viewPreferences && typeof viewPreferences === 'object' && 'showToolCalls' in viewPreferences
      ? viewPreferences.showToolCalls : undefined;
    return { value: typeof value === 'boolean' ? value : null, updatedAt: null };
  },
  write: (metadata, update) => {
    const value = z.boolean().nullable().parse(update.value);
    const work = metadata.work && typeof metadata.work === 'object' ? metadata.work : {};
    const storedViewPreferences = 'viewPreferences' in work ? work.viewPreferences : undefined;
    const currentViewPreferences: Record<string, unknown> = {
      ...(storedViewPreferences && typeof storedViewPreferences === 'object' ? storedViewPreferences : {}),
    };
    const { showToolCalls: _previous, ...viewPreferences } = currentViewPreferences;
    return { ...metadata, work: { ...work,
      viewPreferences: { ...viewPreferences, ...(value === null ? {} : { showToolCalls: value }) },
    } };
  },
};
