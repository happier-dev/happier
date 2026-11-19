// One-bit trace of the Happier mark. Each hex digit packs four pixels.
const size = 160;
const extent = 1.08;
const trace =
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000001ffffffc00000000003ffffff800000000000001fffffffe00000000007fffffff8000000' +
    '0000007ffffffff0000000000ffffffffe000000000001fffffffff8000000001fffffffff800000000003fffffffff8000000001fffffffffc00000' +
    '000007fffffffff8000000001fffffffffe0000000000ffffffffff8000000001ffffffffff0000000001ffffffffff8000000001ffffffffff80000' +
    '00003ffffffffff8000000001ffffffffffc000000007ffffffffff8000000001ffffffffffe00000000fffffffffff8000000001fffffffffff0000' +
    '0000fffffffffff8000000001fffffffffff00000001fffffffffff8000000001fffffffffff80000001fffffffffff8000000001fffffffffff8000' +
    '0003fffffffffff8000000001fffffffffffc0000003fffffffffff8000000001fffffffffffc0000003fffffffffff8000000001fffffffffffc000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe0000007fffffffffff8000000001fffffffffffe000' +
    '0007fffffffffff8000000001fffffffffffe0000007fffffffffffc000000003fffffffffffe0000007fffffffffffc000000003fffffffffffe000' +
    '0007fffffffffffe000000007fffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffff0ffffffffffffffffffcffffffe0000007fffffc03fffffffffffffffff03fffffe000' +
    '0007fffffc03ffffffffffffffffe01fffffe0000007fffff801ffffffffffffffffe00fffffe0000007fffff801ffffffffffffffffc00fffffe000' +
    '0007fffff800ffffffffffffffff800fffffe0000007fffffc007fffffffffffffff800fffffe0000007fffffc003fffffffffffffff001fffffe000' +
    '0007fffffe003ffffffffffffffe001fffffe0000007fffffe001ffffffffffffffc003fffffe0000007ffffff000ffffffffffffff8003fffffe000' +
    '0007ffffff8007fffffffffffff0007fffffe0000007ffffff8001ffffffffffffe000ffffffe0000007ffffffc000ffffffffffffc001ffffffe000' +
    '0007ffffffe0007fffffffffff0001ffffffe0000007fffffff0001ffffffffffe0003ffffffe0000007fffffff8000ffffffffff80007ffffffe000' +
    '0007fffffffc0003ffffffffe0000fffffffe0000007fffffffe00007fffffff80001fffffffe0000007ffffffff00000ffffffc00003fffffffe000' +
    '0007ffffffff800000ffffc00000ffffffffe0000007ffffffffe000000000000001ffffffffe0000007fffffffff000000000000003ffffffffe000' +
    '0007fffffffffc0000000000000fffffffffe0000007fffffffffe0000000000001fffffffffe0000007ffffffffff8000000000007fffffffffe000' +
    '0007ffffffffffe00000000001ffffffffffe0000007fffffffffffc000000000fffffffffffe0000007ffffffffffff800000007fffffffffffe000' +
    '0007fffffffffffff8000007ffffffffffffe0000007ffffffffffffffe001ffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe0000007ffffffffffffffffffffffffffffffffe000' +
    '0007ffffffffffffffffffffffffffffffffe0000003ffffffffffffffffffffffffffffffffc0000003ffffffffffffffffffffffffffffffffc000' +
    '0003ffffffffffffffffffffffffffffffffc0000001ffffffffffffffffffffffffffffffff80000001ffffffffffffffffffffffffffffffff8000' +
    '0000ffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffff000000007ffffffffffffffffffffffffffffffe0000' +
    '00003ffffffffffffffffffffffffffffffc000000001ffffffffffffffffffffffffffffff8000000000ffffffffffffffffffffffffffffff00000' +
    '000007ffffffffffffffffffffffffffffe00000000003ffffffffffffffffffffffffffffc00000000001ffffffffffffffffffffffffffff800000' +
    '0000007ffffffffffffffffffffffffffe0000000000001ffffffffffffffffffffffffff800000000000001ffffffffffffffffffffffff80000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000';

let field;
function createSignedField() {
    const inside = new Uint8Array(size * size);
    for (let i = 0; i < inside.length; i++) inside[i] = (Number.parseInt(trace[i >> 2], 16) >> (3 - (i & 3))) & 1;
    const distances = new Float32Array(inside.length).fill(size);
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const i = y * size + x;
            if (inside[i] !== inside[i - 1] || inside[i] !== inside[i + 1] || inside[i] !== inside[i - size] || inside[i] !== inside[i + size]) distances[i] = 0.5;
        }
    }
    for (const direction of [1, -1]) {
        for (let y = 1; y < size - 1; y++) {
            for (let x = 1; x < size - 1; x++) {
                const i = direction === 1 ? y * size + x : (size - 1 - y) * size + size - 1 - x;
                const row = i - size * direction;
                distances[i] = Math.min(distances[i], distances[i - direction] + 1, distances[row] + 1,
                    distances[row - 1] + Math.SQRT2, distances[row + 1] + Math.SQRT2);
            }
        }
    }
    return distances.map((distance, i) => distance * (inside[i] ? 1 : -1) * 2 * extent / (size - 1));
}

export function markSdfAt(x, y) {
    if (Math.abs(x) > extent || Math.abs(y) > extent) return -extent;
    field ??= createSignedField();
    const column = Math.round((x + extent) / (2 * extent) * (size - 1));
    const row = Math.round((y + extent) / (2 * extent) * (size - 1));
    return field[row * size + column];
}
