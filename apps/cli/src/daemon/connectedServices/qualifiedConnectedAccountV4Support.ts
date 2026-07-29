import type {
  resolveQualifiedConnectedAccountAtomicV4Negotiation,
} from '@/api/client/qualifiedConnectedAccountApi';

export type QualifiedConnectedAccountV4Support = ReturnType<
  typeof resolveQualifiedConnectedAccountAtomicV4Negotiation
>;
