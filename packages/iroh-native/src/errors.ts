export type IrohErrorCode = 'unavailable' | 'invalid_descriptor' | 'identity_mismatch' | 'invalid_preamble' | 'unsupported_alpn' | 'transport';

export class IrohError extends Error {
  readonly code: IrohErrorCode;
  constructor(code: IrohErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IrohError';
    this.code = code;
  }
}
