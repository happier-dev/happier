import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierStoredImage } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ImageWell } from '@/components/ui/media/ImageWell';
import { STORED_IMAGE_HOST } from '@/components/ui/media/StoredImagePicture';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { CHECKOUT_PAGE_URI, TERMINAL_URI } from '@/components/screenCapture/dev/screenCaptureFixtures';
import { recordRealClip } from '@/components/screenCapture/dev/RecordingSpecimen';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { Text } from '@/components/ui/text/Text';
import { FileViewerBody } from '@/components/workspaces/files/file/FileViewerBody';
import { ImageCompare } from '@/components/workspaces/scm/review/imageCompare/ImageCompare';
import type { ImageCompareSide } from '@/components/workspaces/scm/review/imageCompare/imageCompareModel';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';

/* eslint-disable @typescript-eslint/no-require-imports -- dev specimen: bundled sample media */
const SAMPLES = {
  planetDark: require('@/assets/onboarding/planet-dark.jpg'),
  planetLight: require('@/assets/onboarding/planet-light.jpg'),
  icon: require('@/assets/images/icon.png'),
  favicon: require('@/assets/images/favicon.png'),
} as const;
/* eslint-enable @typescript-eslint/no-require-imports */

function assetUri(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    const record = source as Record<string, unknown>;
    if (typeof record.uri === 'string') return record.uri;
    if ('default' in record) return assetUri(record.default);
  }
  return '';
}

const CHECKOUT_ITEM: MediaStageItem = { kind: 'image', title: 'Screenshot 2026-10-31 at 10.42.png', source: uriSource(CHECKOUT_PAGE_URI) };
const TERMINAL_ITEM: MediaStageItem = { kind: 'image', title: 'storefront — vitest.png', source: uriSource(TERMINAL_URI) };

const encoder = new TextEncoder();

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="240" height="240"><circle cx="60" cy="60" r="44" fill="#1d1a17"/><path d="M38 66c6 10 14 15 22 15s16-5 22-15" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round"/></svg>';

/** A two-page PDF with real text, assembled with a correct xref so pdf.js parses it without repair. */
function buildSamplePdf(): Uint8Array {
  const pages = [
    'BT /F1 22 Tf 72 720 Td (3. Handshake) Tj ET BT /F1 12 Tf 72 690 Td (A device opens a relay session; on a timeout it will retry the HELLO.) Tj ET',
    'BT /F1 22 Tf 72 720 Td (3.1 Retries) Tj ET BT /F1 12 Tf 72 690 Td (Each retry backs off: retry after 4, 8 and 16 seconds.) Tj ET',
  ];
  const objects: string[] = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  pages.forEach((content, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + index * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`,
    );
    objects.push(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(body);
}

function uriSource(uri: string): UseFilePreviewSourceInput {
  return { enabled: true, source: { kind: 'uri', uri } };
}

/** Dev-only: the Media stage and viewer bodies on bundled sample media (files lab MS1, FV2b, FV4, FV5). */
export function MediaViewerSpecimen() {
  const { theme } = useUnistyles();
  const stage = useMediaStage();
  const refs = React.useRef([
    React.createRef<View>(),
    React.createRef<View>(),
    React.createRef<View>(),
  ]).current;
  const pdfBytes = React.useMemo(buildSamplePdf, []);
  const svgBytes = React.useMemo(() => encoder.encode(SAMPLE_SVG), []);
  const gallery = React.useMemo<MediaStageItem[]>(
    () => [
      {
        kind: 'image',
        title: 'planet-dark.jpg',
        source: uriSource(assetUri(SAMPLES.planetDark)),
        originRef: refs[0],
      },
      {
        kind: 'image',
        title: 'planet-light.jpg',
        source: uriSource(assetUri(SAMPLES.planetLight)),
        originRef: refs[1],
      },
      {
        kind: 'image',
        title: 'icon.png',
        source: uriSource(assetUri(SAMPLES.icon)),
        originRef: refs[2],
      },
      {
        kind: 'pdf',
        title: 'relay-handshake.pdf',
        source: {
          enabled: true,
          source: {
            kind: 'bytes',
            bytes: pdfBytes,
            name: 'relay-handshake.pdf',
          },
          cacheScopeId: 'dev',
          cacheKey: 'relay-handshake.pdf',
        },
      },
    ],
    [pdfBytes, refs],
  );
  const textStyle = { color: theme.colors.text.secondary };
  // RV1 wells when a side's read did not finish (Retry reads it again) beside one that cannot be read.
  const [afterRead, setAfterRead] = React.useState<ImageCompareSide>({ kind: 'unavailable', reason: {
    kind: 'loadFailed',
    error: 'The direct machine connection was interrupted. Retry the transfer.',
  } });
  // A Markdown or stage image larger than the preview budget: the well says so and offers no Retry.
  const oversized = React.useMemo(() => ({ enabled: true, mimeType: 'image/jpeg', sizeBytes: 18_000_000, maxBytes: 16 * 1024 * 1024,
    source: { kind: 'bytes' as const, bytes: new Uint8Array(18_000_000), name: 'merced-river.jpg' } }), []);
  const planetDark = uriSource(assetUri(SAMPLES.planetDark));
  const planetLight = uriSource(assetUri(SAMPLES.planetLight));
  return (
    <View style={styles.root} testID="dev-media-specimen">
      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Media stage</Text>
      <View style={styles.row}>
        {gallery.slice(0, 3).map((item, index) => (
          <View key={item.title} style={styles.thumb}>
            <ImageWell
              kind="image"
              title={item.title}
              source={item.source}
              alphaCapable={item.title.endsWith('.png')}
              layout="inline"
              originRef={refs[index]}
              onOpenStage={() => stage.open(gallery, index)}
              testID={`dev-media-thumb-${index}`}
            />
          </View>
        ))}
      </View>
      <RoundButton
        size="small"
        display="secondary"
        title="Open gallery at the PDF"
        onPress={() => stage.open(gallery, 3)}
        testID="dev-media-open-pdf"
      />
      {/* The annotator's lab picture, as a composer tray opens it: marks land in place (P2 F1). */}
      <RoundButton
        size="small"
        display="secondary"
        title="Annotate a composer screenshot"
        onPress={() => stage.open([{ ...CHECKOUT_ITEM, edit: { commit: async () => ({ ok: false, reason: 'specimen' }), revert: async () => ({ ok: false, reason: 'specimen' }) } }, TERMINAL_ITEM], 0)}
        testID="dev-media-open-composer-picture"
      />
      <RoundButton
        size="small"
        display="secondary"
        title="Annotate a message picture"
        onPress={() => stage.open([CHECKOUT_ITEM, TERMINAL_ITEM], 0)}
        testID="dev-media-open-message-picture"
      />
      {/* A received video: pause it, mark the frame with numbered steps and attach it (platform lab `media`). */}
      <RoundButton
        size="small"
        display="secondary"
        title="Mark a frame of a received video"
        onPress={() => { void recordRealClip().then(uri => stage.open([{ kind: 'video', title: 'checkout-1440.webm', source: uriSource(uri) }], 0)); }}
        testID="dev-media-open-video"
      />
      {/* MS1 failure: a picture whose read does not finish; the stage offers Retry (RFSM-02). */}
      <RoundButton
        size="small"
        display="secondary"
        title="Open a picture whose read fails"
        onPress={() => stage.open([{ kind: 'image', title: 'harbour-at-dusk.jpg', source: uriSource('/dev-media/harbour-at-dusk.jpg') }], 0)}
        testID="dev-media-open-failed"
      />

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Image well · transparent, tiny, SVG</Text>
      <View style={[styles.page, { borderColor: theme.colors.border.default }]}>
        <FileViewerBody
          viewer={resolveFileViewerKind({ path: 'icon.png' })}
          title="icon.png"
          source={uriSource(assetUri(SAMPLES.icon))}
          isActive
          findSurfaceId="dev-media-icon"
          testID="dev-media-icon"
        />
      </View>
      <View style={[styles.page, { borderColor: theme.colors.border.default }]}>
        <FileViewerBody
          viewer={resolveFileViewerKind({ path: 'favicon.png' })}
          title="favicon.png"
          source={uriSource(assetUri(SAMPLES.favicon))}
          isActive
          findSurfaceId="dev-media-tiny"
          testID="dev-media-tiny"
        />
      </View>
      <View style={[styles.page, { borderColor: theme.colors.border.default }]}>
        <FileViewerBody
          viewer={resolveFileViewerKind({ path: 'logo-dark.svg' })}
          title="logo-dark.svg"
          source={{
            enabled: true,
            source: { kind: 'bytes', bytes: svgBytes, name: 'logo-dark.svg' },
            mimeType: 'image/svg+xml',
            cacheScopeId: 'dev',
            cacheKey: 'logo-dark.svg',
          }}
          isActive
          findSurfaceId="dev-media-svg"
          testID="dev-media-svg"
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Image body · over the preview budget</Text>
      <View style={[styles.compare, { borderColor: theme.colors.border.default }]}>
        <ImageWell
          kind="image"
          title="merced-river.jpg"
          source={oversized}
          alphaCapable={false}
          layout="inline"
          testID="dev-media-well-too-large"
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Image compare · transparent picture</Text>
      <View style={[styles.compare, { borderColor: theme.colors.border.default }]}>
        <ImageCompare
          testID="dev-media-compare-alpha"
          filePath="assets/icon.png"
          kind="image"
          alphaCapable
          before={{ kind: 'present', uri: assetUri(SAMPLES.icon), sizeBytes: null }}
          after={{ kind: 'present', uri: assetUri(SAMPLES.favicon), sizeBytes: null }}
          beforePreviewInput={uriSource(assetUri(SAMPLES.icon))}
          afterPreviewInput={uriSource(assetUri(SAMPLES.favicon))}
          beforeLabel="HEAD"
          afterLabel="working tree"
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Image compare · a read that did not finish</Text>
      <View style={[styles.compare, { borderColor: theme.colors.border.default }]}>
        <ImageCompare
          testID="dev-media-compare-failed"
          filePath="assets/planet.jpg"
          kind="image"
          alphaCapable={false}
          before={{ kind: 'present', uri: assetUri(SAMPLES.planetDark), sizeBytes: null }}
          after={afterRead}
          beforePreviewInput={planetDark}
          afterPreviewInput={planetLight}
          beforeLabel="HEAD"
          afterLabel="working tree"
          onRetry={() => setAfterRead({ kind: 'present', uri: assetUri(SAMPLES.planetLight), sizeBytes: null })}
        />
      </View>
      <View style={[styles.compare, { borderColor: theme.colors.border.default }]}>
        <ImageCompare
          testID="dev-media-compare-unreadable"
          filePath="assets/planet.jpg"
          kind="image"
          alphaCapable={false}
          before={{ kind: 'unavailable', reason: { kind: 'unverified', error: 'The revision bytes do not match their content hash.' } }}
          after={{ kind: 'present', uri: assetUri(SAMPLES.planetLight), sizeBytes: null }}
          beforePreviewInput={planetDark}
          afterPreviewInput={planetLight}
          beforeLabel="turn 4"
          afterLabel="working tree"
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Image compare · no preview, and why</Text>
      <View style={[styles.compare, { borderColor: theme.colors.border.default }]}>
        <ImageCompare
          testID="dev-media-compare-too-large"
          filePath="assets/merced-river.tiff"
          kind="image"
          alphaCapable={false}
          before={{ kind: 'present', uri: assetUri(SAMPLES.planetDark), sizeBytes: null }}
          after={{ kind: 'unavailable', reason: { kind: 'tooLarge', sizeBytes: 40_265_318 } }}
          beforePreviewInput={planetDark}
          afterPreviewInput={planetLight}
          beforeLabel="HEAD"
          afterLabel="working tree"
          onRetry={() => undefined}
        />
      </View>
      <View style={[styles.compare, { borderColor: theme.colors.border.default }]}>
        <ImageCompare
          testID="dev-media-compare-missing"
          filePath="assets/icon.heic"
          kind="image"
          alphaCapable={false}
          before={{ kind: 'unavailable', reason: { kind: 'missing' } }}
          after={{ kind: 'unavailable', reason: { kind: 'unsupported' } }}
          beforePreviewInput={planetDark}
          afterPreviewInput={planetLight}
          beforeLabel="turn 4"
          afterLabel="working tree"
          onRetry={() => undefined}
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>PDF</Text>
      <View style={[styles.tall, { borderColor: theme.colors.border.default }]}>
        <FileViewerBody
          viewer={resolveFileViewerKind({ path: 'relay-handshake.pdf' })}
          title="relay-handshake.pdf"
          source={gallery[3]!.source}
          isActive
          findSurfaceId="dev-media-pdf"
          testID="dev-media-pdf"
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Stored image · transparent logo and a photo</Text>
      <View style={styles.row}>
        <HappierStoredImage
          identity="dev-stored-logo"
          status="loaded"
          uri={`data:image/svg+xml;utf8,${encodeURIComponent(SAMPLE_SVG)}`}
          dimensions={{ width: 120, height: 120 }}
          host={STORED_IMAGE_HOST}
          borderColor={theme.colors.border.default}
          backgroundColor={theme.colors.surface.elevated}
          checkerboardColor={theme.colors.text.primary}
          accessibilityLabel="logo-dark.svg"
          placeholder={null}
          testID="dev-media-stored-logo"
        />
        <HappierStoredImage
          identity="dev-stored-photo"
          status="loaded"
          uri={assetUri(SAMPLES.planetDark)}
          dimensions={{ width: 120, height: 120 }}
          host={STORED_IMAGE_HOST}
          borderColor={theme.colors.border.default}
          backgroundColor={theme.colors.surface.elevated}
          accessibilityLabel="planet-dark.jpg"
          placeholder={null}
          testID="dev-media-stored-photo"
        />
      </View>

      <Text variant="heading" style={{ color: theme.colors.text.primary }}>Binary identity</Text>
      <View style={[styles.page, { borderColor: theme.colors.border.default }]}>
        <FileViewerBody
          viewer={resolveFileViewerKind({
            path: 'target/release/happier',
            isBinaryContent: true,
          })}
          title="happier"
          source={{ enabled: false, source: { kind: 'uri', uri: '' } }}
          sizeBytes={48_600_000}
          isActive
          findSurfaceId="dev-media-bin"
          onDownload={() => {}}
          onOpenInDefaultApp={() => {}}
          onOpenAsText={() => {}}
          testID="dev-media-bin"
        />
      </View>
      <Text variant="meta" style={textStyle}>
        Sample media is bundled with the app; nothing here talks to a machine.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s16,
  },
  row: {
    flexDirection: 'row',
    gap: theme.space.s12,
  },
  thumb: {
    width: 220,
  },
  page: {
    height: 420,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.space.s12,
    overflow: 'hidden',
  },
  compare: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.space.s12,
    overflow: 'hidden',
  },
  tall: {
    height: 640,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.space.s12,
    overflow: 'hidden',
  },
}));
