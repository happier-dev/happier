// v1 atlas headers for tests with a stubbed platform image codec.
export const PET_ATLAS_PNG_HEADER = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 6, 0, 0, 0, 7, 80, 8, 6, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
]);

export const PET_ATLAS_WEBP_HEADER = Uint8Array.from([
    82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80,
    86, 80, 56, 88, 10, 0, 0, 0, 16, 0, 0, 0, 255, 5, 0, 79, 7, 0,
]);
