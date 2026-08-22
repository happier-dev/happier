import {
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
} from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import {
    ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT,
    deriveAccountEncryptionTransitionMeasuredCapacity,
} from "./accountEncryptionTransitionMeasuredCapacity";

const CENSUS_PAGE_ITEMS =
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS;

describe("Account encryption transition measured capacity", () => {
    it("derives every bound from the recorded PEP1 measurement", () => {
        const measurement = ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT;
        const capacity = deriveAccountEncryptionTransitionMeasuredCapacity({
            measurement,
            censusPageItems: CENSUS_PAGE_ITEMS,
        });
        const expectedParticipantLimit = Math.ceil(
            measurement.censusParticipantRows / CENSUS_PAGE_ITEMS,
        ) * CENSUS_PAGE_ITEMS;
        const expectedEncodedByteLimit =
            measurement.nearMaximumParticipantEncodedBytes
            * BigInt(expectedParticipantLimit);
        expect(capacity).toEqual({
            participantLimit: expectedParticipantLimit,
            encodedByteLimit: expectedEncodedByteLimit,
            reservedCapacityBytes: expectedEncodedByteLimit * 2n,
        });
    });

    it("admits the measured census on both retained sides at once", () => {
        const measurement = ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT;
        const capacity = deriveAccountEncryptionTransitionMeasuredCapacity({
            measurement,
            censusPageItems: CENSUS_PAGE_ITEMS,
        });
        const measuredCensusFootprint =
            measurement.nearMaximumParticipantEncodedBytes
            * BigInt(measurement.censusParticipantRows);
        // The three fences the coordinator applies to an authorized census:
        // participant count, one side's bytes, and the source+target peak.
        expect(capacity.participantLimit)
            .toBeGreaterThanOrEqual(measurement.censusParticipantRows);
        expect(capacity.encodedByteLimit >= measuredCensusFootprint).toBe(true);
        expect(capacity.reservedCapacityBytes >= measuredCensusFootprint * 2n)
            .toBe(true);
    });

    it("rounds a census up to whole released pages rather than truncating it", () => {
        const oneRowPastAPage = deriveAccountEncryptionTransitionMeasuredCapacity({
            measurement: {
                censusParticipantRows: CENSUS_PAGE_ITEMS + 1,
                nearMaximumParticipantEncodedBytes: 1_000n,
            },
            censusPageItems: CENSUS_PAGE_ITEMS,
        });
        expect(oneRowPastAPage.participantLimit).toBe(CENSUS_PAGE_ITEMS * 2);
        expect(oneRowPastAPage.encodedByteLimit)
            .toBe(1_000n * BigInt(CENSUS_PAGE_ITEMS * 2));

        const exactlyOnePage = deriveAccountEncryptionTransitionMeasuredCapacity({
            measurement: {
                censusParticipantRows: CENSUS_PAGE_ITEMS,
                nearMaximumParticipantEncodedBytes: 1_000n,
            },
            censusPageItems: CENSUS_PAGE_ITEMS,
        });
        expect(exactlyOnePage.participantLimit).toBe(CENSUS_PAGE_ITEMS);
    });
});
