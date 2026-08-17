import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';

/**
 * Typed author inputs for the public direct-Data client. The cold manifest is
 * still the canonical admission and contract-normalization owner; these values
 * let this package open only the admitted Collections through that public API.
 */
export const Projects = defineAccountCollection({
    id: 'projects',
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', minLength: 1, maxLength: 256 },
            title: { type: 'string', minLength: 1, maxLength: 256 },
        },
        required: ['id', 'title'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    identityFields: [],
    serverReadable: ['title'],
    indexes: [{
        id: 'by-title',
        fields: [{ field: 'title', direction: 'asc' }],
    }],
    uiQueries: [],
    relations: [],
});

export const Tasks = defineAccountCollection({
    id: 'tasks',
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', minLength: 1, maxLength: 256 },
            title: { type: 'string', minLength: 1, maxLength: 256 },
            status: { type: 'string', enum: ['open', 'done'] },
            dueAt: { type: 'string', format: 'date-time', maxLength: 64 },
            projectId: { type: 'string', minLength: 1, maxLength: 256 },
        },
        required: ['id', 'title', 'status', 'dueAt', 'projectId'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    identityFields: [],
    serverReadable: ['title', 'status', 'dueAt', 'projectId'],
    indexes: [{
        id: 'byProjectAndStatus',
        fields: [
            { field: 'projectId', direction: 'asc' },
            { field: 'status', direction: 'asc' },
            { field: 'dueAt', direction: 'asc' },
        ],
    }],
    uiQueries: [{
        id: 'openByProject',
        indexId: 'byProjectAndStatus',
        parameters: { projectId: { kind: 'string', maxUtf8Bytes: 256 } },
        prefix: [
            { kind: 'parameter', parameterId: 'projectId' },
            { kind: 'literal', value: 'open' },
        ],
        order: 'asc',
        pageSize: 50,
        projectedFields: ['title', 'status', 'dueAt'],
    }],
    relations: [{
        id: 'project',
        kind: 'collection',
        field: 'projectId',
        collectionId: 'projects',
        required: true,
        onDelete: 'restrict',
    }],
});
