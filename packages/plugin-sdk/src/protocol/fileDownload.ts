import {
    FileDownloadDestinationV1ProtocolSchema as canonicalDestination,
    FileDownloadResultV1ProtocolSchema as canonicalResult,
} from '@happier-dev/protocol/actions/filesystemActionFamily';

import type { FilesystemActionInputById, FilesystemActionResultById } from '../actions/dtos/filesystemActionDtos.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** The filesystem Action's receiver-issued destination, without path or URL authority. */
export type FileDownloadDestinationV1 = FilesystemActionInputById['daemon.filesystem.download']['destination'];
/** The canonical transfer outcomes; acceptance alone does not mean bytes were saved. */
export type FileDownloadResultV1 = FilesystemActionResultById['daemon.filesystem.download'];

export const FileDownloadDestinationV1ProtocolSchema: ProtocolComposableSchema<FileDownloadDestinationV1> = canonicalDestination;
export const FileDownloadResultV1ProtocolSchema: ProtocolComposableSchema<FileDownloadResultV1> = canonicalResult;
