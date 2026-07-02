type JsonSchemaObject = Readonly<Record<string, unknown>>;

type ValidationResult = Readonly<
    | { success: true }
    | { success: false; message: string }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTypeNames(schema: JsonSchemaObject): readonly string[] {
    const type = schema.type;
    if (typeof type === 'string') {
        return Object.freeze([type]);
    }
    if (Array.isArray(type)) {
        return Object.freeze(type.filter((entry): entry is string => typeof entry === 'string'));
    }
    return Object.freeze([]);
}

function typeMatches(value: unknown, typeName: string): boolean {
    switch (typeName) {
        case 'array':
            return Array.isArray(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'null':
            return value === null;
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'object':
            return isRecord(value);
        case 'string':
            return typeof value === 'string';
        default:
            return true;
    }
}

function valueLabel(value: unknown): string {
    if (Array.isArray(value)) {
        return 'array';
    }
    if (value === null) {
        return 'null';
    }
    return typeof value;
}

function readStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.filter((entry): entry is string => typeof entry === 'string'));
}

function schemaAtPath(path: string, message: string): ValidationResult {
    return {
        success: false,
        message: path ? `${path}: ${message}` : message,
    };
}

function validateSchemaValue(
    schema: JsonSchemaObject,
    value: unknown,
    path: string,
): ValidationResult {
    const typeNames = readTypeNames(schema);
    if (typeNames.length > 0 && !typeNames.some((typeName) => typeMatches(value, typeName))) {
        return schemaAtPath(path, `expected ${typeNames.join(' or ')}, received ${valueLabel(value)}`);
    }

    const enumValues = schema.enum;
    if (Array.isArray(enumValues) && !enumValues.some((entry) => Object.is(entry, value))) {
        return schemaAtPath(path, 'value is not in the allowed enum set');
    }

    if ('const' in schema && !Object.is(schema.const, value)) {
        return schemaAtPath(path, 'value does not match const');
    }

    const shouldValidateObjectShape = typeNames.includes('object')
        || isRecord(schema.properties)
        || Array.isArray(schema.required);
    if (shouldValidateObjectShape) {
        if (!isRecord(value)) {
            return schemaAtPath(path, `expected object, received ${valueLabel(value)}`);
        }
        const required = readStringArray(schema.required);
        for (const requiredKey of required) {
            if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
                return schemaAtPath(path ? `${path}.${requiredKey}` : requiredKey, 'required property is missing');
            }
        }

        const properties = isRecord(schema.properties) ? schema.properties : {};
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (!Object.prototype.hasOwnProperty.call(value, key) || !isRecord(propertySchema)) {
                continue;
            }
            const result = validateSchemaValue(
                propertySchema,
                value[key],
                path ? `${path}.${key}` : key,
            );
            if (!result.success) {
                return result;
            }
        }

        if (schema.additionalProperties === false) {
            const allowedKeys = new Set(Object.keys(properties));
            const extraKey = Object.keys(value).find((key) => !allowedKeys.has(key));
            if (extraKey) {
                return schemaAtPath(path ? `${path}.${extraKey}` : extraKey, 'additional property is not allowed');
            }
        }
    }

    if (typeNames.includes('array') || isRecord(schema.items)) {
        if (!Array.isArray(value)) {
            return schemaAtPath(path, `expected array, received ${valueLabel(value)}`);
        }
        if (isRecord(schema.items)) {
            for (const [index, item] of value.entries()) {
                const result = validateSchemaValue(schema.items, item, `${path}[${index}]`);
                if (!result.success) {
                    return result;
                }
            }
        }
    }

    return { success: true };
}

export function validatePluginEventPayloadSchema(params: Readonly<{
    payloadSchema: JsonSchemaObject;
    payload: unknown;
}>): ValidationResult {
    return validateSchemaValue(params.payloadSchema, params.payload, 'payload');
}
