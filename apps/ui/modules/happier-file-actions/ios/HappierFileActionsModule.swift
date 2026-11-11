import ExpoModulesCore
import QuickLook
import UIKit

/// Quick Look for one downloaded file. The preview renders HTML, PDF, Office and media files,
/// and its own share button hands the file to Safari, Files or another app ("Open with…").
/// The promise settles when the person dismisses the preview, so JS keeps the cache file until then.
public final class HappierFileActionsModule: Module {
  private var presented: QuickLookSession?

  public func definition() -> ModuleDefinition {
    Name("HappierFileActions")

    AsyncFunction("previewFile") { (fileUri: String, promise: Promise) in
      guard let url = URL(string: fileUri), url.isFileURL else {
        promise.reject("ERR_FILE_URI", "Preview needs a local file URL")
        return
      }
      guard QLPreviewController.canPreview(url as NSURL) else {
        promise.resolve(["status": "unsupported"])
        return
      }
      guard self.presented == nil else {
        promise.reject("ERR_PREVIEW_BUSY", "Another file preview is open")
        return
      }
      guard let host = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_NO_VIEW_CONTROLLER", "No screen is available to present the preview")
        return
      }
      let session = QuickLookSession(url: url) { [weak self] in
        self?.presented = nil
        promise.resolve(["status": "dismissed"])
      }
      self.presented = session
      host.present(session.controller, animated: true)
    }.runOnQueue(.main)
  }
}

private final class QuickLookSession: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  let controller = QLPreviewController()
  private let url: URL
  private let onDismiss: () -> Void

  init(url: URL, onDismiss: @escaping () -> Void) {
    self.url = url
    self.onDismiss = onDismiss
    super.init()
    controller.dataSource = self
    controller.delegate = self
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    url as NSURL
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    onDismiss()
  }
}
