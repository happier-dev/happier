import { tokenColumnFacts } from '../apiTokens/collection/tokenColumnAdapter';
import { defineSettingsCollectionAdapter } from '../shell/settingsCollectionAdapter';

export const embedColumnAdapter = defineSettingsCollectionAdapter(['status']);
/** Embeds are token summaries; their existing owner supplies the embed context, not an access grant. */
export const embedColumnFacts = tokenColumnFacts;
