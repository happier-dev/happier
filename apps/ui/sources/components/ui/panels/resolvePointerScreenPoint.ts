import {
    resolvePointerClientPoint,
    type PointerClientPoint,
} from './resolvePointerClientPoint';

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFirstIndexedRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    const record = readRecord(value);
    const first = record[0];
    return first != null ? readRecord(first) : null;
}

export function resolvePointerScreenPoint(event: unknown): PointerClientPoint {
    const eventRecord = readRecord(event);
    const nativeEvent = readRecord(eventRecord.nativeEvent);

    const directX = readNumber(nativeEvent.screenX) ?? readNumber(eventRecord.screenX);
    const directY = readNumber(nativeEvent.screenY) ?? readNumber(eventRecord.screenY);
    if (directX != null || directY != null) {
        return { x: directX ?? null, y: directY ?? null };
    }

    const touch0 = readFirstIndexedRecord(eventRecord.touches)
        ?? readFirstIndexedRecord(eventRecord.changedTouches);
    const touchX = readNumber(touch0?.screenX);
    const touchY = readNumber(touch0?.screenY);
    if (touchX != null || touchY != null) {
        return { x: touchX ?? null, y: touchY ?? null };
    }

    return resolvePointerClientPoint(event);
}
