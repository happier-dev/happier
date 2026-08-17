import type { JsonValue } from './identity.js';
import type {
    AccountKvEntry,
    AccountKvListItem,
    AccountKvService,
    AccountKvTransaction,
    StorageService,
} from './storage.js';

type Assert<Condition extends true> = Condition;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type AreMutuallyAssignable<Left, Right> = IsAssignable<Left, Right> extends true
    ? IsAssignable<Right, Left>
    : false;

type ExpectedAccountKvEntry =
    | Readonly<{ version: number; value: JsonValue }>
    | Readonly<{ version: number; deleted: true }>;

// A logical key has one author-visible state: live or retained deletion. The
// physical Account-row revision is deliberately absent from this SDK shape.
type _AccountKvEntryIsThePublicLiveOrTombstoneUnion = Assert<
    AreMutuallyAssignable<AccountKvEntry, ExpectedAccountKvEntry>
>;
type _AccountKvGetDistinguishesNeverExistingFromDeleted = Assert<
    AreMutuallyAssignable<
        Awaited<ReturnType<AccountKvTransaction['get']>>,
        AccountKvEntry | null
    >
>;
type _AccountKvListExposesTombstoneVersions = Assert<
    AreMutuallyAssignable<
        Awaited<ReturnType<AccountKvService['list']>>['items'][number],
        AccountKvListItem
    >
>;

declare const transaction: AccountKvTransaction;

void transaction.set('checkpoint', { offset: 1 }, { expectedVersion: 'absent' });
void transaction.set('checkpoint', { offset: 2 }, { expectedVersion: 4 });
void transaction.delete('checkpoint', { expectedVersion: 4 });

// `absent` is only a never-existing precondition; deletion/revival requires
// the retained numeric version, and every mutation is conditional.
// @ts-expect-error Account KV writes must name their conditional version.
void transaction.set('checkpoint', { offset: 1 });
// @ts-expect-error A tombstone cannot be deleted through an absent precondition.
void transaction.delete('checkpoint', { expectedVersion: 'absent' });

type _AccountScopeIsAbsentUntilTheHostAdmitsIt = Assert<
    IsAssignable<undefined, StorageService['account']>
>;
