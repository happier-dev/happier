import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '../../domains/state/storageTypes';

type PersistTimestampedLocalSessionDataParams<TValue extends string> = Readonly<{
    sessions: Record<string, Session>;
    previousValues: Record<string, TValue>;
    previousUpdatedAts: Record<string, number>;
    readValue: (session: Session) => TValue | null | undefined;
    readUpdatedAt: (session: Session) => number | null | undefined;
    shouldPersistValue: (value: TValue, session: Session) => boolean;
    saveValues: (values: Record<string, TValue>, scope?: ServerAccountScope | null) => void;
    saveUpdatedAts: (updatedAts: Record<string, number>, scope?: ServerAccountScope | null) => void;
    scope?: ServerAccountScope | null;
    errorMessage: string;
}>;

export type PersistTimestampedLocalSessionDataResult<TValue extends string> = Readonly<{
    values: Record<string, TValue>;
    updatedAts: Record<string, number>;
}>;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function persistTimestampedLocalSessionData<TValue extends string>({
    sessions,
    previousValues,
    previousUpdatedAts,
    readValue,
    readUpdatedAt,
    shouldPersistValue,
    saveValues,
    saveUpdatedAts,
    scope,
    errorMessage,
}: PersistTimestampedLocalSessionDataParams<TValue>): PersistTimestampedLocalSessionDataResult<TValue> | null {
    const values: Record<string, TValue> = { ...previousValues };
    const updatedAts: Record<string, number> = { ...previousUpdatedAts };

    Object.entries(sessions).forEach(([sessionId, session]) => {
        delete values[sessionId];
        delete updatedAts[sessionId];

        const updatedAt = readUpdatedAt(session);
        if (!isFiniteNumber(updatedAt)) return;

        updatedAts[sessionId] = updatedAt;
        const value = readValue(session);
        if (typeof value === 'string' && shouldPersistValue(value, session)) {
            values[sessionId] = value;
        }
    });

    try {
        saveValues(values, scope);
        saveUpdatedAts(updatedAts, scope);
        return { values, updatedAts };
    } catch (e) {
        console.error(errorMessage, e);
        return null;
    }
}
