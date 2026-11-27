import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const PREFIX_BYTES = 13;
const SEPARATOR = ',\n';
const END = '\n]\n';
export const SCHEMA_SECTIONS = ['inputSchema', 'resultSchema'];

/** Render the publisher's already projected summary and schema maps once. */
export function renderIndexedBundledDeclaration(projection) {
    const input = JSON.stringify(projection.inputSchema.valuesByActionId);
    const result = JSON.stringify(projection.resultSchema.valuesByActionId);
    const header = JSON.stringify({
        ...projection.summary,
        sectionBytes: { inputSchema: Buffer.byteLength(input), resultSchema: Buffer.byteLength(result) },
    });
    const headerLength = Buffer.byteLength(header).toString(16).padStart(8, '0');
    return `["${headerLength}",\n${header}${SEPARATOR}${input}${SEPARATOR}${result}${END}`;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSectionLength(value) {
    return Number.isSafeInteger(value) && value >= 2;
}

function admitHeader(header) {
    if (!isRecord(header) || header.v !== 1 || !isRecord(header.manifest)
        || !isRecord(header.inputHintsByActionId) || typeof header.declarationDigest !== 'string'
        || typeof header.canonicalDeclarationDigest !== 'string'
        || !isSectionLength(header.sectionBytes?.inputSchema)
        || !isSectionLength(header.sectionBytes?.resultSchema)) {
        throw new Error('Invalid bundled plugin declaration header');
    }
    return header;
}

function admitValues(values) {
    if (!isRecord(values)) throw new Error('Invalid bundled plugin declaration schema section');
    return values;
}

function readUtf8(fd, offset, length) {
    const bytes = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
        const count = readSync(fd, bytes, done, length - done, offset + done);
        if (count === 0) throw new Error('Truncated bundled plugin declaration');
        done += count;
    }
    return bytes.toString('utf8');
}

function decodePublication(size, read, consume) {
    const prefix = /^\["([a-f0-9]{8})",\n$/u.exec(read(0, PREFIX_BYTES));
    const headerLength = prefix ? Number.parseInt(prefix[1], 16) : 0;
    if (!headerLength || headerLength > size - PREFIX_BYTES) {
        throw new Error('Invalid bundled plugin declaration index');
    }
    const header = admitHeader(JSON.parse(read(PREFIX_BYTES, headerLength)));
    const inputOffset = PREFIX_BYTES + headerLength + SEPARATOR.length;
    const resultOffset = inputOffset + header.sectionBytes.inputSchema + SEPARATOR.length;
    if (resultOffset + header.sectionBytes.resultSchema + END.length !== size) {
        throw new Error('Invalid bundled plugin declaration section lengths');
    }
    return consume(header, section => admitValues(JSON.parse(read(
        section === 'inputSchema' ? inputOffset : resultOffset, header.sectionBytes[section]))));
}

/** Read one admitted publication on a single descriptor, including any requested schema map. */
export function withIndexedBundledDeclaration(path, consume) {
    const fd = openSync(path, 'r');
    try {
        return decodePublication(fstatSync(fd).size, (offset, length) => readUtf8(fd, offset, length), consume);
    } finally {
        closeSync(fd);
    }
}

function materializeManifest(header, readSection) {
    const values = { inputSchema: readSection('inputSchema'), resultSchema: readSection('resultSchema') };
    const actions = header.manifest.contributes?.actions;
    if (Array.isArray(actions)) {
        for (const action of actions) {
            for (const section of SCHEMA_SECTIONS) {
                if (Object.hasOwn(action, section)) action[section] = values[section][action.id];
            }
        }
    }
    return header.manifest;
}

/** Restore the publisher's manifest, including schema positions, for full consumers. */
export function readIndexedBundledDeclarationManifest(path) {
    return withIndexedBundledDeclaration(path, materializeManifest);
}

/** For Git/tree consumers that already own the complete publication bytes. */
export function decodeIndexedBundledDeclarationManifest(bytes) {
    return decodePublication(bytes.length, (offset, length) => bytes.toString('utf8', offset, offset + length), materializeManifest);
}

/** Source builders can also read the object publications of earlier revisions. */
export function decodeBundledDeclarationManifest(bytes) {
    return bytes[0] === 0x5b
        ? decodeIndexedBundledDeclarationManifest(bytes)
        : JSON.parse(bytes.toString('utf8'));
}
