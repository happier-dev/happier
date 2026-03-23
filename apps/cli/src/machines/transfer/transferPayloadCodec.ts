export type TransferPayloadCodec<TPayload> = Readonly<{
  encode: (payload: TPayload) => Buffer;
  decode: (input: Readonly<{ transferId: string; payload: Buffer }>) => TPayload;
}>;

function createInvalidTransferPayloadError(message: string, error: unknown): Error {
  if (error instanceof Error && error.message === message) {
    return error;
  }
  return new Error(message);
}

export function createJsonTransferPayloadCodec<TPayload>(params: Readonly<{
  encodePayload: (payload: TPayload) => unknown;
  decodePayload: (payload: unknown) => TPayload;
  invalidPayloadMessage: string;
  mapDecodeError?: (input: Readonly<{ transferId: string; error: unknown }>) => Error;
}>): TransferPayloadCodec<TPayload> {
  return {
    encode: (payload) => Buffer.from(JSON.stringify(params.encodePayload(payload)), 'utf8'),
    decode: ({ transferId, payload }) => {
      try {
        const parsedPayload = JSON.parse(payload.toString('utf8'));
        return params.decodePayload(parsedPayload);
      } catch (error) {
        if (params.mapDecodeError) {
          throw params.mapDecodeError({ transferId, error });
        }
        throw createInvalidTransferPayloadError(params.invalidPayloadMessage, error);
      }
    },
  };
}
