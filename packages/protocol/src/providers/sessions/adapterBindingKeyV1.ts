import { ProviderLocalIdSchema } from '../ids.js';

// Engine-local binding keys share one conservative, rematerializable grammar across persisted
// launch metadata and binding-security fingerprints. Agent adapters may further narrow it.
export const ProviderAdapterBindingKeyV1Schema = ProviderLocalIdSchema;
export type ProviderAdapterBindingKeyV1 = string;
