// Use production modal chrome and lifecycle in the Chromium Run journey.
// The shared history builder's default dialog boundary is for editor guard prompts.
export { Modal } from '@/modal/ModalManager';
export { ModalProvider, useModal, useOptionalModal, useVisibleModalKind } from '@/modal/ModalProvider';
export * from '@/modal/types';
