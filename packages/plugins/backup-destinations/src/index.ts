export { PLUGIN_MANIFEST, manifest } from './manifest.js';
export { activate } from './activate.js';
export { prepareLocalDestination, prepareSftpDestination, LocalDestinationConfigSchema, SftpDestinationConfigSchema } from './transports.js';
export { prepareS3Destination, S3DestinationConfigSchema, S3DestinationOpenSchema,
  type S3DestinationConfig, type S3DestinationOpen, type S3DestinationCredentialRole } from './s3.js';
