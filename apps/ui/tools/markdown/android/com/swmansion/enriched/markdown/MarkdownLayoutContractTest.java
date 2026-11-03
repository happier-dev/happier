package com.swmansion.enriched.markdown;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.text.LineBreaker;
import android.text.Layout;
import android.text.NoCopySpan;
import android.text.Selection;
import android.text.Spannable;
import android.text.SpannableString;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.style.LeadingMarginSpan;
import android.text.style.StyleSpan;
import android.view.ContextThemeWrapper;
import com.facebook.react.bridge.JavaOnlyMap;
import com.facebook.react.uimanager.DisplayMetricsHolder;
import com.facebook.yoga.YogaMeasureMode;
import com.facebook.yoga.YogaMeasureOutput;
import com.swmansion.enriched.markdown.accessibility.AccessibleMarkdownTextView;
import com.swmansion.enriched.markdown.parser.MarkdownASTNode;
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType;
import com.swmansion.enriched.markdown.renderer.Renderer;
import com.swmansion.enriched.markdown.styles.StyleConfig;
import com.swmansion.enriched.markdown.spans.TaskListSpan;
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListTapUtils;
import com.swmansion.enriched.markdown.utils.text.view.TextViewSetupKt;
import com.swmansion.enriched.markdown.views.TableContainerView;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class MarkdownLayoutContractTest {
  private Context context;
  private TextPaint paint;
  private StyleConfig style;

  @Before public void setUp() {
    context = new ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat);
    DisplayMetricsHolder.initDisplayMetrics(context);
    paint = new TextPaint(Paint.ANTI_ALIAS_FLAG);
    paint.setTextSize(16f);
    paint.setTypeface(Typeface.DEFAULT);
    style = new StyleConfig(styleFixture(), context, false, 0f);
    assertTrue("Native graphics must measure real glyphs", layout("Native text", 360).getLineWidth(0) > 0f);
  }

  // JS supplies normalized maps at the native boundary; these values exercise real renderers.
  private static JavaOnlyMap blockStyle() {
    return JavaOnlyMap.of("fontSize", 16d, "fontFamily", "", "fontWeight", "normal", "color", 0xff202020,
        "lineHeight", 26d, "marginTop", 0d, "marginBottom", 0d, "textAlign", "auto");
  }

  private static JavaOnlyMap styleFixture() {
    JavaOnlyMap table = blockStyle();
    for (String key : new String[] {"borderWidth", "borderRadius", "cellPaddingHorizontal", "cellPaddingVertical"}) table.putDouble(key, 2d);
    for (String key : new String[] {"headerBackgroundColor", "headerTextColor", "rowEvenBackgroundColor", "rowOddBackgroundColor", "borderColor"}) table.putInt(key, 0xff202020);
    table.putString("headerFontFamily", "");
    JavaOnlyMap list = blockStyle();
    for (String key : new String[] {"bulletSize", "markerMinWidth", "gapWidth", "marginLeft"}) list.putDouble(key, 8d);
    list.putInt("bulletColor", 0xff202020); list.putInt("markerColor", 0xff202020); list.putString("markerFontWeight", "normal");
    JavaOnlyMap result = JavaOnlyMap.of(
        "paragraph", blockStyle(), "table", table, "list", list,
        "strong", JavaOnlyMap.of("fontFamily", "", "fontWeight", "bold"),
        "em", JavaOnlyMap.of("fontFamily", "", "fontStyle", "italic"),
        "strikethrough", JavaOnlyMap.of("color", 0xff202020),
        "link", JavaOnlyMap.of("fontFamily", "", "color", 0xff202020, "underline", true),
        "code", JavaOnlyMap.of("fontFamily", "", "fontSize", 0d, "color", 0xff202020, "backgroundColor", 0xffeeeeee, "borderColor", 0xff202020),
        "taskList", JavaOnlyMap.of("checkedColor", 0xff202020, "borderColor", 0xff202020, "checkboxSize", 14d,
            "checkboxBorderRadius", 3d, "checkmarkColor", 0xffffffff, "checkedTextColor", 0xff202020, "checkedStrikethrough", false),
        "spoiler", JavaOnlyMap.of("color", 0xff202020, "particles", JavaOnlyMap.of("density", 8d, "speed", 20d), "solid", JavaOnlyMap.of("borderRadius", 4d)));
    for (int level = 1; level <= 6; level++) result.putMap("h" + level, blockStyle());
    return result;
  }

  private static MarkdownASTNode node(NodeType type, String content, MarkdownASTNode... children) {
    return new MarkdownASTNode(type, content, Collections.emptyMap(), Arrays.asList(children));
  }

  private Spannable render(MarkdownASTNode document) {
    Renderer renderer = new Renderer();
    renderer.configure(style, context);
    return renderer.renderDocument(document, null, null);
  }

  private StaticLayout layout(CharSequence text, int width) {
    return StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
        .setIncludePad(false).setLineSpacing(0f, 1f)
        .setBreakStrategy(LineBreaker.BREAK_STRATEGY_HIGH_QUALITY)
        .setUseLineSpacingFromFallbacks(true).build();
  }

  private static float maxWidth(Layout layout) {
    float width = 0;
    for (int line = 0; line < layout.getLineCount(); line++) width = Math.max(width, layout.getLineWidth(line));
    return width;
  }

  private void assertGeometry(CharSequence expected, CharSequence actual, int width) {
    Layout a = layout(expected, width), b = layout(actual, width);
    assertEquals(a.getHeight(), b.getHeight());
    assertEquals(a.getLineCount(), b.getLineCount());
    for (int line = 0; line < a.getLineCount(); line++) {
      assertEquals(a.getLineStart(line), b.getLineStart(line));
      assertEquals(a.getLineEnd(line), b.getLineEnd(line));
      assertEquals(a.getLineWidth(line), b.getLineWidth(line), 0.001f);
      assertEquals(a.getLineLeft(line), b.getLineLeft(line), 0.001f);
    }
  }

  private static class Margin implements LeadingMarginSpan {
    private final String name;
    private final List<String> calls;
    Margin(String name, List<String> calls) { this.name = name; this.calls = calls; }
    public int getLeadingMargin(boolean first) { return 8; }
    public void drawLeadingMargin(Canvas c, Paint p, int x, int dir, int top, int baseline,
        int bottom, CharSequence text, int start, int end, boolean first, Layout layout) {
      calls.add(name + ":" + start + ":" + x);
    }
  }

  private List<String> drawMargins(CharSequence text, List<String> calls) {
    calls.clear();
    Layout l = layout(text, 360);
    Bitmap bitmap = Bitmap.createBitmap(400, l.getHeight(), Bitmap.Config.ARGB_8888);
    l.draw(new Canvas(bitmap));
    bitmap.recycle();
    return new ArrayList<>(calls);
  }

  @Test public void paragraphOrderingSpanIdentityAndSelectionSurviveViewAdoption() {
    Spannable text = render(node(NodeType.Document, "", node(NodeType.Paragraph, "", node(NodeType.Text, "Outer paragraph\nInner paragraph\n"))));
    List<String> calls = new ArrayList<>();
    Margin inner = new Margin("inner", calls), outer = new Margin("outer", calls);
    int second = text.toString().indexOf('\n') + 1;
    text.setSpan(inner, second, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    text.setSpan(outer, 0, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    StyleSpan priority = new StyleSpan(Typeface.BOLD);
    text.setSpan(priority, second, text.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE | (2 << Spanned.SPAN_PRIORITY_SHIFT));
    NoCopySpan marker = new NoCopySpan.Concrete();
    text.setSpan(marker, 1, 1, Spanned.SPAN_MARK_MARK);
    SpannableString frozen = new SpannableString(text);
    List<String> expected = drawMargins(frozen, calls);
    // A bare builder is fast, but Android Layout changes the nested margin draw order.
    assertNotEquals(expected, drawMargins(new SpannableStringBuilder(frozen), calls));
    assertEquals(expected, drawMargins(text, calls));
    for (int width : new int[] {40, 360}) assertGeometry(frozen, text, width);

    AccessibleMarkdownTextView view = new AccessibleMarkdownTextView(context) {};
    TextViewSetupKt.setupAsMarkdownTextView(view);
    view.setText(text);
    Spannable adopted = (Spannable) view.getText();
    assertSame("The view must adopt its uniquely owned render buffer without flattening the span index", text, adopted);
    assertSame(priority, adopted.getSpans(second, text.length(), StyleSpan.class)[0]);
    assertEquals(text.getSpanFlags(priority), adopted.getSpanFlags(priority));
    assertEquals(1, text.getSpanStart(marker));
    assertEquals(1, adopted.getSpanStart(marker));
    assertEquals(expected, drawMargins(adopted, calls));
    Selection.setSelection(adopted, 1, second);
    assertEquals(1, view.getSelectionStart());
    assertEquals(second, view.getSelectionEnd());
    assertEquals(frozen.toString().substring(1, second), adopted.subSequence(1, second).toString());
    // Later renders own fresh buffers; TextView selection/watchers must not leak into them.
    Spannable next = render(node(NodeType.Document, "", node(NodeType.Paragraph, "", node(NodeType.Text, "Next render"))));
    assertEquals(-1, next.getSpanStart(marker));
    assertEquals(-1, Selection.getSelectionStart(next));
    view.setText(next);
    assertEquals("Next render", view.getText().toString());
  }

  @Test public void tableDisplayAndMeasurementAgreeForStyledCells() {
    MarkdownASTNode table = node(NodeType.Table, "",
        node(NodeType.TableHead, "", node(NodeType.TableRow, "",
            node(NodeType.TableHeaderCell, "", node(NodeType.Strong, "", node(NodeType.Text, "Header"))))),
        node(NodeType.TableBody, "", node(NodeType.TableRow, "",
            node(NodeType.TableCell, "", node(NodeType.Emphasis, "", node(NodeType.Text, "A body cell with enough words to wrap onto another line"))))));
    float measured = TableContainerView.Companion.measureTableNodeHeight(table, style, context);
    TableContainerView view = new TableContainerView(context, style);
    view.applyTableNode(table);
    view.measure(android.view.View.MeasureSpec.makeMeasureSpec(360, android.view.View.MeasureSpec.AT_MOST),
        android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED));
    assertTrue(measured > 0);
    assertEquals((int) Math.ceil(measured), view.getMeasuredHeight());
    System.out.printf(Locale.ROOT, "MD_TABLE measured_height=%.3f display_height=%d%n", measured, view.getMeasuredHeight());
  }

  @Test public void nestedTaskToggleClonesItsBufferAndPreservesLayoutThroughReflow() {
    MarkdownASTNode inner = new MarkdownASTNode(NodeType.ListItem, "", Collections.singletonMap("isTask", "true"),
        Collections.singletonList(node(NodeType.Paragraph, "", node(NodeType.Text, "Inner task"))));
    MarkdownASTNode outer = new MarkdownASTNode(NodeType.ListItem, "", Collections.singletonMap("isTask", "true"),
        Arrays.asList(node(NodeType.Paragraph, "", node(NodeType.Text, "Outer task")), node(NodeType.UnorderedList, "", inner)));
    Spannable original = render(node(NodeType.Document, "", node(NodeType.UnorderedList, "", outer)));
    AccessibleMarkdownTextView view = new AccessibleMarkdownTextView(context) {};
    TextViewSetupKt.setupAsMarkdownTextView(view);
    view.setText(original);
    Selection.setSelection((Spannable) view.getText(), 1, 3);
    NoCopySpan marker = new NoCopySpan.Concrete();
    original.setSpan(marker, 2, 2, Spanned.SPAN_MARK_MARK);
    assertTrue(TaskListTapUtils.INSTANCE.updateTaskListItemCheckedState(view, 0, true, style));
    Spannable toggled = (Spannable) view.getText();
    assertNotSame(original, toggled);
    assertEquals("The toggle clone must omit source-only markers", -1, toggled.getSpanStart(marker));
    for (TaskListSpan span : original.getSpans(0, original.length(), TaskListSpan.class)) assertFalse(span.isChecked());
    for (TaskListSpan span : toggled.getSpans(0, toggled.length(), TaskListSpan.class)) assertEquals(span.getTaskIndex() == 0, span.isChecked());
    SpannableString frozen = new SpannableString(toggled);
    for (int width : new int[] {40, 360}) {
      assertGeometry(frozen, toggled, width);
      Layout expectedDrawing = layout(frozen, width), actualDrawing = layout(toggled, width);
      Bitmap expectedPixels = Bitmap.createBitmap(width, expectedDrawing.getHeight(), Bitmap.Config.ARGB_8888);
      Bitmap actualPixels = Bitmap.createBitmap(width, actualDrawing.getHeight(), Bitmap.Config.ARGB_8888);
      expectedDrawing.draw(new Canvas(expectedPixels));
      actualDrawing.draw(new Canvas(actualPixels));
      assertTrue("Nested checkbox drawing must retain the frozen span order", expectedPixels.sameAs(actualPixels));
      expectedPixels.recycle(); actualPixels.recycle();
      JavaOnlyMap props = JavaOnlyMap.of("markdown", "seed");
      MeasurementStore.INSTANCE.getMeasureById(context, 4343, width, 0f, YogaMeasureMode.UNDEFINED, props, false);
      MeasurementStore.INSTANCE.store(4343, toggled, paint);
      int nextWidth = width == 40 ? 360 : 40;
      long measured = MeasurementStore.INSTANCE.getMeasureById(context, 4343, nextWidth, 0f, YogaMeasureMode.UNDEFINED, props, false);
      Layout expected = layout(frozen, nextWidth);
      assertEquals((float) Math.ceil(maxWidth(expected)), YogaMeasureOutput.getWidth(measured), 0.001f);
      assertEquals((float) expected.getHeight(), YogaMeasureOutput.getHeight(measured), 0.001f);
      MeasurementStore.INSTANCE.release(4343);
    }
    assertEquals(1, Selection.getSelectionStart(original));
    assertEquals(3, Selection.getSelectionEnd(original));
  }

  /** The benchmark has no guessed time ceiling: compare its raw phases on the same host. */
  @Test public void profileDenseRenderedTextThroughViewAndStore() {
    int[][] cases = {{64, 16, 40}, {256, 16, 40}, {1024, 16, 360}, {1024, 0, 360}};
    for (int[] sample : cases) {
      int paragraphs = sample[0], density = sample[1], width = sample[2];
      List<MarkdownASTNode> nodes = new ArrayList<>();
      for (int i = 0; i < paragraphs; i++) {
        List<MarkdownASTNode> children = new ArrayList<>();
        for (int j = 0; j < 16; j++) children.add(density == 0 ? node(NodeType.Text, "word ") : node(NodeType.Strong, "", node(NodeType.Text, "word ")));
        nodes.add(new MarkdownASTNode(NodeType.Paragraph, "", Collections.emptyMap(), children));
      }
      MarkdownASTNode document = new MarkdownASTNode(NodeType.Document, "", Collections.emptyMap(), nodes);
      long renderNanos = 0, adoptNanos = 0, buildNanos = 0, scanNanos = 0, storeNanos = 0;
      int lines = 0, chars = 0, spans = 0; float max = 0;
      for (int repeat = -1; repeat < 3; repeat++) {
        long start = System.nanoTime(); Spannable text = render(document); long rendered = System.nanoTime();
        AccessibleMarkdownTextView view = new AccessibleMarkdownTextView(context) {};
        TextViewSetupKt.setupAsMarkdownTextView(view);
        long adoptStart = System.nanoTime(); view.setText(text); long adopted = System.nanoTime();
        CharSequence display = view.getText();
        long buildStart = System.nanoTime(); Layout layout = layout(display, width); long built = System.nanoTime();
        max = maxWidth(layout); long scanned = System.nanoTime();
        JavaOnlyMap props = JavaOnlyMap.of("markdown", "seed");
        MeasurementStore.INSTANCE.getMeasureById(context, 4242, width, 0f, YogaMeasureMode.UNDEFINED, props, false);
        long storeStart = System.nanoTime(); MeasurementStore.INSTANCE.store(4242, display, paint); long stored = System.nanoTime();
        long size = MeasurementStore.INSTANCE.getMeasureById(context, 4242, width, 0f, YogaMeasureMode.UNDEFINED, props, false);
        assertEquals((float) Math.ceil(max), YogaMeasureOutput.getWidth(size), 0.001f);
        assertEquals((float) Math.ceil(layout.getHeight()), YogaMeasureOutput.getHeight(size), 0.001f);
        MeasurementStore.INSTANCE.release(4242);
        if (repeat >= 0) { renderNanos += rendered-start; adoptNanos += adopted-adoptStart; buildNanos += built-buildStart; scanNanos += scanned-built; storeNanos += stored-storeStart; }
        lines = layout.getLineCount(); chars = text.length(); spans = text.getSpans(0, chars, Object.class).length;
      }
      System.out.printf(Locale.ROOT, "MD_PIPELINE paragraphs=%d chars=%d spans=%d density=%d width=%d lines=%d max=%.3f render_ms=%.3f adopt_ms=%.3f build_ms=%.3f scan_ms=%.3f store_ms=%.3f total_render_adopt_store_ms=%.3f%n",
          paragraphs, chars, spans, density, width, lines, max, renderNanos/3e6, adoptNanos/3e6, buildNanos/3e6, scanNanos/3e6, storeNanos/3e6, (renderNanos+adoptNanos+storeNanos)/3e6);
    }
  }
}
