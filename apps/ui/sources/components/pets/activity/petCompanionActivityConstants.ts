export const PET_COMPANION_ACTIVITY_EXPIRY_MS = {
    running: 180_000,
    failed: 3_600_000,
    waiting: 86_400_000,
    review: 604_800_000,
    idle: null,
} as const;

export const PET_COMPANION_ACTIVITY_PRIORITY = {
    waiting: 0,
    failed: 1,
    review: 2,
    running: 3,
    idle: 4,
} as const;
