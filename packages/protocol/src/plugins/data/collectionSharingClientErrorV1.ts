import type { PluginCollectionSharingErrorV1Schema } from './collectionSharingV1.js';

type OperationOutcome = 'refused' | 'failed' | 'uncertain';
type OperationRefusal = ReturnType<typeof PluginCollectionSharingErrorV1Schema.parse>;
export class PluginCollectionSharingClientErrorV1 extends Error {
  constructor(readonly code: string, readonly outcome: OperationOutcome = 'refused', readonly details?: OperationRefusal) {
    super(code); this.name = 'PluginCollectionSharingClientError';
  }
}
