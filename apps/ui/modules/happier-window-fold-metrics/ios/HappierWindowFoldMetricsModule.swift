import ExpoModulesCore
import UIKit

public final class HappierWindowFoldMetricsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierWindowFoldMetrics")
    View(HappierWindowFoldMetricsView.self) {
      Events("onMetricsChange")
    }
  }
}

/// The mounted view identifies the actual window/scene instead of guessing a global key window.
final class HappierWindowFoldMetricsView: ExpoView {
  let onMetricsChange = EventDispatcher()
  private var lastMetrics: NSDictionary?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false

    // Verified against both installed SDKs: 26.2 excludes this code; 27.1 includes it.
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      addInteraction(UIHingeInteraction { [weak self] _, _ in
        self?.publishMetrics()
      })
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: HappierWindowFoldMetricsView, _: UITraitCollection) in view.publishMetrics()
      }
    }
    #endif
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    lastMetrics = nil
    publishMetrics()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    publishMetrics()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    publishMetrics()
  }

  private func publishMetrics() {
    guard let window, window.bounds.width > 0, window.bounds.height > 0 else {
      publish([:])
      return
    }

    var divisions: [[String: CGFloat]] = []
    var verticalBarEdge: Any = NSNull()
    #if canImport(UIKit, _version: 9127.0.85)
    if #available(iOS 27.1, *) {
      switch traitCollection.verticalBarEdge {
      case .leading: verticalBarEdge = "leading"
      case .trailing: verticalBarEdge = "trailing"
      default: break
      }
      for region in reservedRegions(kind: .division) where region.isActive {
        let frame = convert(region.frame, to: window).intersection(window.bounds)
        // A division can be a line. Do not discard it merely because CGRect.isEmpty is true.
        guard !frame.isNull, frame.width > 0 || frame.height > 0 else { continue }
        divisions.append([
          "x": frame.minX - window.bounds.minX,
          "y": frame.minY - window.bounds.minY,
          "width": frame.width,
          "height": frame.height,
        ])
      }
    }
    #endif

    // No hinge-detection timeout: publish current regions immediately, including an empty list.
    // UIHingeInteraction's documented initial/change callbacks and view layout invalidate geometry.
    // RN safe areas already expose the Duo vertical bar (observed right=84pt, left=0pt folded).
    publish(["width": window.bounds.width, "height": window.bounds.height, "divisions": divisions, "verticalBarEdge": verticalBarEdge])
  }

  private func publish(_ metrics: [String: Any]) {
    let next = metrics as NSDictionary
    guard lastMetrics?.isEqual(next) != true else { return }
    lastMetrics = next
    onMetricsChange(metrics)
  }
}
