import { projectSessionDisplayV1, sealSessionOwnerDisplayEnvelopeV1, sealSessionSharedDisplayEnvelopeV1Sync } from '@happier-dev/protocol/sessions';
import { SessionOwnerMetadataV1Schema, SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createPlainSessionCurrentProjectionRecordFixture } from './sessionFixtures';

/** A persisted current tuple; opt in when the test is not exercising display backfill. */
export function createPlainSessionWithDisplayRecordFixture(
    overrides: Parameters<typeof createPlainSessionCurrentProjectionRecordFixture>[0] = {},
) {
    const record = createPlainSessionCurrentProjectionRecordFixture(overrides);
    if (record.ownerMetadata?.t !== 'plain' || typeof record.metadata !== 'string') {
        throw new Error('Expected a plain owner Session fixture');
    }
    const display = projectSessionDisplayV1({
        sharedMetadata: SessionSharedMetadataV1Schema.parse(JSON.parse(record.metadata)),
        ownerMetadata: SessionOwnerMetadataV1Schema.parse(record.ownerMetadata.v),
    });
    if (!display.owner) throw new Error('Expected an owner display');
    const shared = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display: display.shared });
    const owner = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', display: display.owner });
    if (!shared.ok || !owner.ok) throw new Error('Expected sealed plain display fixtures');
    return SessionCurrentProjectionRecordV1Schema.parse({ ...record, displayProjectionV1: {
        v: 1, sourceMetadataVersion: record.metadataVersion, metadataLayoutVersion: record.metadataLayoutVersion,
        shared: shared.envelope, owner: owner.envelope,
    } });
}
